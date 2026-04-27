const CODE_TO_KEY: Record<string, string> = {
  KeyA: "a", KeyB: "b", KeyC: "c", KeyD: "d", KeyE: "e", KeyF: "f",
  KeyG: "g", KeyH: "h", KeyI: "i", KeyJ: "j", KeyK: "k", KeyL: "l",
  KeyM: "m", KeyN: "n", KeyO: "o", KeyP: "p", KeyQ: "q", KeyR: "r",
  KeyS: "s", KeyT: "t", KeyU: "u", KeyV: "v", KeyW: "w", KeyX: "x",
  KeyY: "y", KeyZ: "z",
  Digit0: "0", Digit1: "1", Digit2: "2", Digit3: "3", Digit4: "4",
  Digit5: "5", Digit6: "6", Digit7: "7", Digit8: "8", Digit9: "9",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
  Backslash: "\\", Semicolon: ";", Quote: "'", Comma: ",",
  Period: ".", Slash: "/", Backquote: "`",
  NumpadSubtract: "numpadsubtract", NumpadAdd: "numpadadd", NumpadMultiply: "numpadmultiply", NumpadDivide: "numpaddivide",
  Space: "space", Enter: "enter", Escape: "escape", Tab: "tab",
  Backspace: "backspace", Delete: "delete",
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
  F1: "f1", F2: "f2", F3: "f3", F4: "f4", F5: "f5", F6: "f6",
  F7: "f7", F8: "f8", F9: "f9", F10: "f10", F11: "f11", F12: "f12"
};

export function normalizeKeyCombo(event: KeyboardEvent): string {
  const parts: string[] = [];

  if (event.ctrlKey || event.metaKey) parts.push("ctrl");
  if (event.shiftKey) parts.push("shift");
  if (event.altKey) parts.push("alt");

  const key = CODE_TO_KEY[event.code];
  if (key) {
    parts.push(key);
  } else {
    parts.push(event.key.toLowerCase());
  }

  return parts.join("+");
}
