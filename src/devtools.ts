/* The devtools page itself is invisible: its only job is to register the panel.
   Everything the user sees lives in panel.html. */
chrome.devtools.panels.create("JWT", "icon-48.png", "panel.html");
