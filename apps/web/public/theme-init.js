// Applies the stored theme before first paint to avoid a flash of the wrong
// palette. Kept as an external file so the production CSP can stay strict
// (`script-src 'self'`) without needing an inline hash.
(function () {
  try {
    var stored = localStorage.getItem("sh-theme");
    var dark =
      stored === "dark" ||
      (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch {
    /* theme detection is best effort */
  }
})();
