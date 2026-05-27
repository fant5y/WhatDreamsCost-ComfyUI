export function hideWidget(w) {
    if (!w) return;
    if (!w._origType && w.type !== "hidden") w._origType = w.type;
    // We don't set w.type = "hidden" anymore because it causes rendering issues in Nodes 2.0.
    // Instead we use the computeSize = () => [0,0] trick which works in both V1 and V2.
    w.hidden = true;
    if (!w.options) w.options = {};
    w.options.hidden = true;
    w.computeSize = () => [0, 0];
    if (w.element) w.element.style.display = "none";
}
