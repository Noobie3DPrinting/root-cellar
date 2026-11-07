// Applies the saved theme and accent before first paint so there is no flash.
try { var t = localStorage.getItem("cb.theme"); if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t); var a = localStorage.getItem("cb.accent"); if (a && a !== "forest") document.documentElement.setAttribute("data-accent", a); } catch (e) {}
