"""Merge glossary-parts/*.md into glossary.md and check the {term} link graph.

Usage: python3 merge_glossary.py BOOK_DIR [--max-depth 5]

Each part file holds definition-list items only (no :::{glossary} wrapper):

    Canonical Name
    : Definition, may link {term}`text <Other Name>`.

Writes BOOK_DIR/glossary.md (entries sorted alphabetically) and exits non-zero if
an entry is duplicated, a linked term (from chapters or entries) has no entry,
the entry graph has a cycle, or a chain is deeper than --max-depth.
"""
import argparse, functools, glob, pathlib, re, sys

TERM = re.compile(r"\{term\}`(?:[^`<]*<([^>]+)>|([^`]+))`")


def target(m):
    return (m.group(1) or m.group(2)).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("book", type=pathlib.Path)
    ap.add_argument("--max-depth", type=int, default=5)
    args = ap.parse_args()
    book, problems = args.book, []

    entries = {}
    for f in sorted(glob.glob(str(book / "glossary-parts" / "*.md"))):
        lines = pathlib.Path(f).read_text().splitlines()
        starts = [i for i in range(len(lines) - 1)
                  if lines[i] and not lines[i][0].isspace() and lines[i + 1].startswith(": ")]
        for a, b in zip(starts, starts[1:] + [len(lines)]):
            name = lines[a].strip()
            if name in entries:
                problems.append(f"duplicate entry {name!r} in {f}")
            entries[name] = "\n".join(lines[a:b]).rstrip()

    edges = {n: sorted({target(m) for m in TERM.finditer(body)}) for n, body in entries.items()}
    used = {target(m) for f in glob.glob(str(book / "chapters" / "*.md"))
            for m in TERM.finditer(pathlib.Path(f).read_text())}
    missing = sorted((used | {t for v in edges.values() for t in v}) - set(entries))
    problems += [f"missing entry: {m}" for m in missing]

    @functools.lru_cache(None)
    def depth(n, stack=()):
        if n in stack:
            raise ValueError("cycle: " + " -> ".join(stack + (n,)))
        return 1 + max((depth(c, stack + (n,)) for c in edges.get(n, []) if c in entries), default=0)

    depths = {}
    try:
        depths = {n: depth(n) for n in entries}
    except ValueError as e:
        problems.append(str(e))
    problems += [f"too deep ({d} > {args.max_depth}): {n}" for n, d in depths.items() if d > args.max_depth]

    body = "\n\n".join(entries[n] for n in sorted(entries, key=str.lower))
    # An empty {glossary} directive is a hard MyST error, so only wrap when there are entries.
    (book / "glossary.md").write_text("# Glossary\n\n:::{glossary}\n" + body + "\n:::\n" if entries else "# Glossary\n")

    print(f"entries: {len(entries)}  max depth: {max(depths.values(), default=0)}")
    for p in problems:
        print("  PROBLEM", p)
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
