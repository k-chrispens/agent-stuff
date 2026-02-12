/**
 * PDF Reader Extension - Extracts text and figures from PDF documents.
 *
 * Uses Mozilla's pdfjs-dist (pure JavaScript, no native dependencies required).
 * Works on Linux, macOS, and Windows wherever Node.js runs.
 *
 * - Text is extracted and reconstructed line-by-line from each page.
 * - Embedded images/figures above a minimum size threshold are extracted
 *   and returned as image content blocks alongside the text.
 * - Large images are downscaled to limit token usage.
 *
 * Image kind handling (from pdfjs ImageKind enum):
 *   1 = GRAYSCALE_1BPP — bit-packed, 1 bit per pixel (8 pixels per byte)
 *   2 = RGB_24BPP      — 3 bytes per pixel (R, G, B)
 *   3 = RGBA_32BPP     — 4 bytes per pixel (R, G, B, A)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";

// Minimum pixel area to consider an image a "figure" (filters out icons, glyphs, artifacts)
const MIN_IMAGE_PIXELS = 10_000; // e.g. ~100x100
// Maximum dimension (width or height) before downscaling
const MAX_IMAGE_DIM = 1024;
// Maximum source image pixels before skipping (prevents huge RGBA buffer allocations).
// 16 megapixels = 64 MB RGBA buffer, which is a reasonable upper bound.
const MAX_IMAGE_SOURCE_PIXELS = 16_000_000;
// Maximum cumulative RGBA bytes across all extracted images (limits peak memory).
// 128 MB covers ~8 full-size 4096x4096 RGBA buffers or many smaller ones.
const MAX_TOTAL_IMAGE_BYTES = 128 * 1024 * 1024;
// Maximum number of images to extract (limits memory and token usage)
const MAX_EXTRACTED_IMAGES = 20;

interface ExtractedImage {
	page: number;
	name: string;
	width: number;
	height: number;
	base64: string;
}

interface ReadPdfDetails {
	path: string;
	totalPages: number;
	pagesReturned: number;
	imagesExtracted: number;
	imagesSkipped: number;
	truncated: boolean;
	fullOutputPath?: string;
}

/**
 * Downscale raw RGBA pixel data using area averaging.
 */
function downscaleRGBA(
	src: Uint8Array | Buffer,
	srcW: number,
	srcH: number,
	dstW: number,
	dstH: number
): Buffer {
	const dst = Buffer.alloc(dstW * dstH * 4);
	const xRatio = srcW / dstW;
	const yRatio = srcH / dstH;

	for (let dy = 0; dy < dstH; dy++) {
		for (let dx = 0; dx < dstW; dx++) {
			const srcX0 = Math.floor(dx * xRatio);
			const srcY0 = Math.floor(dy * yRatio);
			const srcX1 = Math.min(Math.ceil((dx + 1) * xRatio), srcW);
			const srcY1 = Math.min(Math.ceil((dy + 1) * yRatio), srcH);

			let r = 0, g = 0, b = 0, a = 0, count = 0;
			for (let sy = srcY0; sy < srcY1; sy++) {
				for (let sx = srcX0; sx < srcX1; sx++) {
					const idx = (sy * srcW + sx) * 4;
					r += src[idx];
					g += src[idx + 1];
					b += src[idx + 2];
					a += src[idx + 3];
					count++;
				}
			}

			const dIdx = (dy * dstW + dx) * 4;
			dst[dIdx] = Math.round(r / count);
			dst[dIdx + 1] = Math.round(g / count);
			dst[dIdx + 2] = Math.round(b / count);
			dst[dIdx + 3] = Math.round(a / count);
		}
	}
	return dst;
}

/**
 * Infer image kind from data length when kind is not provided by pdfjs.
 * Returns the kind number, or null if the data length doesn't match any known format.
 */
function inferImageKind(dataLength: number, width: number, height: number): number | null {
	const pixels = width * height;
	if (dataLength === pixels * 4) return 3; // RGBA_32BPP
	if (dataLength === pixels * 3) return 2; // RGB_24BPP
	// 1BPP: each row is ceil(width/8) bytes
	const rowBytes = (width + 7) >> 3;
	if (dataLength === rowBytes * height) return 1; // GRAYSCALE_1BPP
	return null;
}

/**
 * Convert raw GRAYSCALE_1BPP (bit-packed) data to RGBA.
 * Each byte contains 8 pixels, MSB first. Set bit = white, unset = black.
 */
function unpack1bppToRGBA(
	imgData: Uint8Array | Buffer,
	width: number,
	height: number,
	rgba: Buffer
): void {
	const rowBytes = (width + 7) >> 3;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const srcByte = imgData[y * rowBytes + (x >> 3)];
			const bit = (srcByte >> (7 - (x & 7))) & 1;
			const v = bit ? 255 : 0;
			const dstIdx = (y * width + x) * 4;
			rgba[dstIdx] = v;
			rgba[dstIdx + 1] = v;
			rgba[dstIdx + 2] = v;
			rgba[dstIdx + 3] = 255;
		}
	}
}

/**
 * Convert raw pixel data from pdfjs into a PNG buffer, downscaling if needed.
 *
 * pdfjs ImageKind values:
 *   1 = GRAYSCALE_1BPP — bit-packed, 1 bit per pixel (8 pixels per byte)
 *   2 = RGB_24BPP      — 3 bytes per pixel
 *   3 = RGBA_32BPP     — 4 bytes per pixel
 */
function imageToPngBuffer(
	imgData: Uint8Array | Buffer,
	width: number,
	height: number,
	kind: number
): { buffer: Buffer; finalWidth: number; finalHeight: number } {
	let rgba: Buffer;

	if (kind === 3) {
		// Already RGBA -- use directly without unnecessary copy
		rgba = imgData instanceof Buffer ? imgData : Buffer.from(imgData);
	} else if (kind === 2) {
		// RGB -> RGBA
		rgba = Buffer.alloc(width * height * 4);
		for (let p = 0; p < width * height; p++) {
			rgba[p * 4] = imgData[p * 3];
			rgba[p * 4 + 1] = imgData[p * 3 + 1];
			rgba[p * 4 + 2] = imgData[p * 3 + 2];
			rgba[p * 4 + 3] = 255;
		}
	} else if (kind === 1) {
		// 1-bit-per-pixel bit-packed -> RGBA
		rgba = Buffer.alloc(width * height * 4);
		unpack1bppToRGBA(imgData, width, height, rgba);
	} else {
		// Unknown kind -- skip this image
		throw new Error(`Unsupported image kind: ${kind}`);
	}

	// Downscale if needed
	let finalW = width;
	let finalH = height;
	let finalData: Buffer = rgba;

	if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
		const scale = MAX_IMAGE_DIM / Math.max(width, height);
		finalW = Math.round(width * scale);
		finalH = Math.round(height * scale);
		finalData = downscaleRGBA(rgba, width, height, finalW, finalH);
	}

	const png = new PNG({ width: finalW, height: finalH });
	png.data = finalData;
	return { buffer: PNG.sync.write(png), finalWidth: finalW, finalHeight: finalH };
}

export default function (pi: ExtensionAPI) {
	// Track temp directories for cleanup on session shutdown
	const tempDirs: string[] = [];

	pi.on("session_shutdown", async () => {
		for (const dir of tempDirs) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup
			}
		}
		tempDirs.length = 0;
	});

	pi.registerTool({
		name: "read_pdf",
		label: "Read PDF",
		description: `Read a PDF file, extracting text content and embedded figures/images. Text is returned as plain text per page. Figures above a minimum size are returned as images (up to ${MAX_EXTRACTED_IMAGES}). Supports optional page range selection. Text output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		parameters: Type.Object({
			path: Type.String({ description: "Path to the PDF file" }),
			startPage: Type.Optional(
				Type.Number({ description: "First page to extract (1-indexed, default: 1)" })
			),
			endPage: Type.Optional(
				Type.Number({
					description: "Last page to extract (1-indexed, inclusive, default: last page)",
				})
			),
			includeImages: Type.Optional(
				Type.Boolean({
					description:
						"Whether to extract embedded figures/images (default: true). Set to false for text-only mode.",
				})
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Normalize leading @ (some models add it)
			const filePath = resolve(ctx.cwd, params.path.replace(/^@/, ""));
			const includeImages = params.includeImages !== false;

			const emptyDetails = (overrides?: Partial<ReadPdfDetails>): ReadPdfDetails => ({
				path: filePath,
				totalPages: 0,
				pagesReturned: 0,
				imagesExtracted: 0,
				imagesSkipped: 0,
				truncated: false,
				...overrides,
			});

			// Read file -- handles not-found and other IO errors without TOCTOU race
			let data: Buffer;
			try {
				data = await readFile(filePath);
			} catch (err: any) {
				const message =
					err?.code === "ENOENT"
						? `File not found: ${filePath}`
						: `Error reading file: ${err?.message ?? String(err)}`;
				return {
					content: [{ type: "text" as const, text: message }],
					details: emptyDetails(),
				};
			}

			// Dynamic import for ESM module
			const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
			const { OPS } = pdfjsLib;

			// Zero-copy Uint8Array view over the Buffer (avoids duplicating the PDF in memory)
			const uint8Array = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

			// Load the PDF document
			const loadingTask = pdfjsLib.getDocument({
				data: uint8Array,
				useSystemFonts: true,
			});

			if (signal) {
				signal.addEventListener("abort", () => loadingTask.destroy(), { once: true });
			}

			const pdf = await loadingTask.promise;

			try {
				const totalPages = pdf.numPages;

				const startPage = Math.max(1, params.startPage ?? 1);
				const endPage = Math.min(totalPages, params.endPage ?? totalPages);

				const pageTexts: string[] = [];
				const extractedImages: ExtractedImage[] = [];
				let imagesSkipped = 0;
				let imageCapReached = false;
				let totalImageBytes = 0;

				// Track seen images across all pages (PDFs reuse image XObjects)
				const seenImages = new Set<string>();

				for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
					if (signal?.aborted) {
						return {
							content: [{ type: "text" as const, text: "Cancelled" }],
							details: emptyDetails({ totalPages }),
						};
					}

					onUpdate?.({
						content: [
							{
								type: "text" as const,
								text: `Reading page ${pageNum} of ${endPage}...`,
							},
						],
					});

					// Wrap page loading so a corrupt page doesn't abort the whole document
					let page;
					try {
						page = await pdf.getPage(pageNum);
					} catch (err: any) {
						pageTexts.push(
							`--- Page ${pageNum} ---\n[Error loading page: ${err?.message ?? String(err)}]`
						);
						continue;
					}

					try {
						// --- Extract text ---
						try {
							const textContent = await page.getTextContent();

							// Group text items by vertical position to reconstruct lines
							const lineMap = new Map<number, { x: number; str: string }[]>();
							for (const item of textContent.items) {
								if (!("str" in item)) continue;
								const y = Math.round(item.transform[5] * 10) / 10;
								if (!lineMap.has(y)) lineMap.set(y, []);
								lineMap.get(y)!.push({ x: item.transform[4], str: item.str });
							}

							// Sort lines top-to-bottom, items left-to-right
							const sortedYs = [...lineMap.keys()].sort((a, b) => b - a);
							const lines: string[] = [];
							for (const y of sortedYs) {
								const items = lineMap.get(y)!.sort((a, b) => a.x - b.x);
								lines.push(items.map((i) => i.str).join(" "));
							}

							pageTexts.push(`--- Page ${pageNum} ---\n${lines.join("\n")}`);
						} catch (err: any) {
							pageTexts.push(
								`--- Page ${pageNum} ---\n[Error extracting text: ${err?.message ?? String(err)}]`
							);
						}

						// --- Extract images/figures ---
						if (!includeImages || imageCapReached) continue;

						let ops;
						try {
							ops = await page.getOperatorList();
						} catch {
							// Operator list extraction failure is non-fatal
							continue;
						}

						for (let i = 0; i < ops.fnArray.length; i++) {
							if (signal?.aborted) break;

							if (
								ops.fnArray[i] !== OPS.paintImageXObject &&
								ops.fnArray[i] !== OPS.paintInlineImageXObject
							) {
								continue;
							}

							const imgName = ops.argsArray[i][0] as string;
							if (seenImages.has(imgName)) continue;
							seenImages.add(imgName);

							// Enforce image extraction limit (count and cumulative memory)
							if (extractedImages.length >= MAX_EXTRACTED_IMAGES || totalImageBytes >= MAX_TOTAL_IMAGE_BYTES) {
								imagesSkipped++;
								imageCapReached = true;
								break;
							}

							try {
								const imgObj = await new Promise<any>((resolve, reject) => {
									const timer = setTimeout(() => reject(new Error("timeout")), 5000);
									page.objs.get(imgName, (obj: any) => {
										clearTimeout(timer);
										resolve(obj);
									});
								});

								if (!imgObj?.data || !imgObj.width || !imgObj.height) continue;

								const pixels = imgObj.width * imgObj.height;

								// Filter out small images (icons, glyphs, artifacts)
								if (pixels < MIN_IMAGE_PIXELS) continue;

								// Skip images that would require excessively large RGBA buffers
								if (pixels > MAX_IMAGE_SOURCE_PIXELS) {
									imagesSkipped++;
									continue;
								}

								// Determine image kind: use pdfjs value, infer from data length, or skip
								let kind: number;
								if (imgObj.kind != null) {
									kind = imgObj.kind;
								} else {
									const inferred = inferImageKind(
										imgObj.data.length,
										imgObj.width,
										imgObj.height
									);
									if (inferred === null) {
										// Cannot determine pixel format
										imagesSkipped++;
										continue;
									}
									kind = inferred;
								}

								// Check cumulative memory budget before allocating RGBA buffer
								const rgbaBytes = imgObj.width * imgObj.height * 4;
								if (totalImageBytes + rgbaBytes > MAX_TOTAL_IMAGE_BYTES) {
									imagesSkipped++;
									continue;
								}
								totalImageBytes += rgbaBytes;

								const { buffer, finalWidth, finalHeight } = imageToPngBuffer(
									imgObj.data,
									imgObj.width,
									imgObj.height,
									kind
								);

								extractedImages.push({
									page: pageNum,
									name: imgName,
									width: finalWidth,
									height: finalHeight,
									base64: buffer.toString("base64"),
								});

								// Yield to event loop between images to keep TUI responsive
								await new Promise((r) => setTimeout(r, 0));
							} catch {
								// Skip images we can't extract (encoding errors, OOM, etc.)
								imagesSkipped++;
							}
						}
					} finally {
						// Release page caches (operator list, image data) to reduce peak memory
						page.cleanup();
					}
				}

				// --- Build text result with truncation ---
				const fullText = pageTexts.join("\n\n");

				const truncation = truncateHead(fullText, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});

				const details: ReadPdfDetails = {
					path: filePath,
					totalPages,
					pagesReturned: endPage - startPage + 1,
					imagesExtracted: extractedImages.length,
					imagesSkipped,
					truncated: truncation.truncated,
				};

				let resultText = truncation.content;

				if (truncation.truncated) {
					const tempDir = mkdtempSync(join(tmpdir(), "pi-pdf-"));
					tempDirs.push(tempDir);
					const tempFile = join(tempDir, "output.txt");
					writeFileSync(tempFile, fullText);
					details.fullOutputPath = tempFile;

					resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
					resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
					resultText += ` Full output saved to: ${tempFile}]`;
				}

				// --- Build content array: text + images ---
				const content: Array<
					| { type: "text"; text: string }
					| { type: "image"; source: { type: "base64"; media_type: string; data: string } }
				> = [{ type: "text", text: resultText }];

				for (const img of extractedImages) {
					content.push({
						type: "text",
						text: `\n[Figure from page ${img.page}: ${img.name} (${img.width}x${img.height})]`,
					});
					content.push({
						type: "image",
						source: {
							type: "base64",
							media_type: "image/png",
							data: img.base64,
						},
					});
				}

				if (imagesSkipped > 0) {
					content.push({
						type: "text",
						text: `\n[${imagesSkipped} image(s) skipped (extraction limit, oversized source, or unsupported format)]`,
					});
				}

				return { content, details };
			} finally {
				// Always clean up the PDF document to release caches and workers
				await pdf.destroy();
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("read_pdf "));
			text += theme.fg("accent", args.path);
			if (args.startPage || args.endPage) {
				const range = `p${args.startPage ?? 1}-${args.endPage ?? "end"}`;
				text += theme.fg("dim", ` (${range})`);
			}
			if (args.includeImages === false) {
				text += theme.fg("dim", " [text-only]");
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as ReadPdfDetails | undefined;

			if (isPartial) {
				return new Text(theme.fg("warning", "Reading PDF..."), 0, 0);
			}

			if (!details) {
				// Safely find the first text content block
				const textBlock = result.content.find(
					(c: { type: string }) => c.type === "text"
				) as { type: "text"; text: string } | undefined;
				const text = textBlock?.text ?? "No content";
				return new Text(theme.fg("dim", text), 0, 0);
			}

			let text = theme.fg(
				"success",
				`${details.pagesReturned} of ${details.totalPages} pages`
			);
			if (details.imagesExtracted > 0) {
				text += theme.fg("accent", `, ${details.imagesExtracted} figures`);
			}
			if (details.imagesSkipped > 0) {
				text += theme.fg("warning", ` (+${details.imagesSkipped} skipped)`);
			}
			if (details.truncated) {
				text += theme.fg("warning", " (text truncated)");
			}

			if (expanded) {
				// Safely find the first text content block
				const textBlock = result.content.find(
					(c: { type: string }) => c.type === "text"
				) as { type: "text"; text: string } | undefined;
				if (textBlock) {
					const lines = textBlock.text.split("\n").slice(0, 30);
					for (const line of lines) {
						text += `\n${theme.fg("dim", line)}`;
					}
					if (textBlock.text.split("\n").length > 30) {
						text += `\n${theme.fg("muted", "...")}`;
					}
				}
				if (details.fullOutputPath) {
					text += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
