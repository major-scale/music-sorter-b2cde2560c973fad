// Segments facade — delegates to the WaveSurfer-based Waveform module (js/waveform.js).
// Kept as window.Segments so the rest of app.js (recordRating, resetTrackUI, the seg-mark
// buttons) needs no changes: it still calls Segments.setAnchor/addRegion/getSegments/etc.

window.Segments = {
  mount() {},
  enable(on) { if (on && window.Waveform) window.Waveform.init(); },
  setActive(label) { if (window.Waveform) window.Waveform.setActive(label); },
  reset() { if (window.Waveform) { window.Waveform.refresh(); window.Waveform.clear(); } },
  clear() { if (window.Waveform) window.Waveform.clear(); },
  restore(neutrals, segments) { if (window.Waveform) window.Waveform.restore(neutrals, segments); },
  setAnchor() { if (window.Waveform) window.Waveform.setAnchor(); },
  addRegion(label) { if (window.Waveform) window.Waveform.addPoint(label); },
  getAnchor() { return window.Waveform ? window.Waveform.getAnchor() : null; },
  getNeutrals() { return window.Waveform ? window.Waveform.getNeutrals() : []; },
  getSegments() { return window.Waveform ? window.Waveform.getSegments() : []; },
};
