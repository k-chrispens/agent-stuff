const MOLSTAR = "https://cdn.jsdelivr.net/npm/molstar@5.13.0/build/viewer";
// The viewer build is UMD (sets window.molstar), so load it once with a script tag, not import.
let ready;
const loadMolstar = () => (ready ??= new Promise((res, rej) => {
  if (window.molstar) return res(window.molstar);
  const s = Object.assign(document.createElement("script"), { src: `${MOLSTAR}/molstar.js` });
  s.onload = () => res(window.molstar);
  s.onerror = rej;
  document.head.appendChild(s);
}));

const node = (kind, params = {}, ...children) => ({ kind, params, children });
const scene = (repr) => ({
  root: node("root", {},
    node("canvas", { background_color: "white" }),
    node("download", { url: "https://files.wwpdb.org/download/1cbs.cif" },
      node("parse", { format: "mmcif" }, node("structure", { type: "model" },
        node("component", { selector: "polymer" }, node("representation", { type: repr }, node("color", { color: "#46a39a" }))),
        node("component", { selector: "ligand" }, node("representation", { type: "ball_and_stick" }, node("color", { color: "#d1495b" }))))))),
  metadata: { version: "1", timestamp: new Date().toISOString() },
});

export default {
  async render({ model, el }) {
    // Shadow DOM: page CSS doesn't reach here, so Mol*'s stylesheet goes inside el.
    el.innerHTML = `<link rel="stylesheet" href="${MOLSTAR}/molstar.css">
      <style>.msp-viewport-controls,.msp-viewport-top-left-controls,.msp-state-snapshot-viewport-controls{display:none!important}
      .stage{position:relative;width:100%;height:320px} .msp-plugin .msp-layout-standard{border:none}</style>
      <button class="toggle"></button><div class="stage"></div>`;
    const btn = el.querySelector(".toggle"), stage = el.querySelector(".stage");
    const molstar = await loadMolstar();
    const viewer = await molstar.Viewer.create(stage, {
      layoutIsExpanded: false, layoutShowControls: false, layoutShowSequence: false, layoutShowLog: false,
      layoutShowLeftPanel: false, layoutShowRemoteState: false, viewportShowExpand: false,
      viewportShowSelectionMode: false, viewportShowAnimation: false, viewportShowControls: false,
      viewportShowSettings: false, viewportShowReset: false, viewportShowScreenshotControls: false,
      viewportShowToggleFullscreen: false, viewportShowTrajectoryControls: false, viewportBackgroundColor: "white",
    });
    viewer.plugin.canvas3d.setProps({ camera: { helper: { axes: { name: "off", params: {} } } } });
    let framed = false;
    const draw = async () => {
      const repr = model.get("repr");
      btn.textContent = `Show ${repr === "cartoon" ? "surface" : "cartoon"}`;
      await viewer.loadMvsData(JSON.stringify(scene(repr)), "mvsj", { keepCamera: framed, sanityChecks: false });
      framed = true;
    };
    btn.onclick = () => model.set("repr", model.get("repr") === "cartoon" ? "surface" : "cartoon");
    model.on("change:repr", draw);
    await draw();
    return () => viewer.dispose();
  },
};
