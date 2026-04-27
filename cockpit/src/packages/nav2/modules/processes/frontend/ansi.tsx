import type { CSSProperties } from "react";

export interface AnsiSegment {
  text: string;
  style: CSSProperties;
}

export interface ParsedAnsiText {
  plainText: string;
  segments: AnsiSegment[];
}

interface AnsiState {
  color?: string;
  backgroundColor?: string;
  fontWeight?: CSSProperties["fontWeight"];
}

const ANSI_FG = ["#24292f", "#cf222e", "#1a7f37", "#9a6700", "#0969da", "#8250df", "#1b7c83", "#57606a"];
const ANSI_FG_BRIGHT = ["#000000", "#a40e26", "#116329", "#7d4e00", "#0550ae", "#6639ba", "#0a5d66", "#24292f"];
const ANSI_BG = ["#d0d7de", "#ffebe9", "#dafbe1", "#fff8c5", "#ddf4ff", "#fbefff", "#bfe5ea", "#f6f8fa"];
const ANSI_BG_BRIGHT = ["#8c959f", "#ffcecb", "#aceebb", "#fde68a", "#b6e3ff", "#e9d5ff", "#afe8f1", "#ffffff"];
const ANSI_CONTROL_PATTERN = /\u001b\[([0-9;?]*)([ -/]*)([@-~])/g;

function cloneState(state: AnsiState): CSSProperties {
  return {
    color: state.color,
    backgroundColor: state.backgroundColor,
    fontWeight: state.fontWeight
  };
}

function ansi256Color(code: number): string {
  if (code < 0) return "#24292f";
  if (code < 8) return ANSI_FG[code] ?? "#24292f";
  if (code < 16) return ANSI_FG_BRIGHT[code - 8] ?? "#24292f";
  if (code < 232) {
    const cube = code - 16;
    const r = Math.floor(cube / 36);
    const g = Math.floor((cube % 36) / 6);
    const b = cube % 6;
    const values = [0, 95, 135, 175, 215, 255];
    return `rgb(${values[r]}, ${values[g]}, ${values[b]})`;
  }
  if (code < 256) {
    const value = 8 + (code - 232) * 10;
    return `rgb(${value}, ${value}, ${value})`;
  }
  return "#24292f";
}

function applyAnsiColor(state: AnsiState, type: "fg" | "bg", value: string | undefined): void {
  if (type === "fg") {
    state.color = value;
    return;
  }
  state.backgroundColor = value;
}

function resetState(state: AnsiState): void {
  state.color = undefined;
  state.backgroundColor = undefined;
  state.fontWeight = undefined;
}

function applySgrCodes(state: AnsiState, rawCodes: string): void {
  const codes = rawCodes.trim() === "" ? [0] : rawCodes.split(";").map((value) => Number(value || "0"));
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (!Number.isFinite(code)) continue;
    if (code === 0) {
      resetState(state);
      continue;
    }
    if (code === 1) {
      state.fontWeight = 700;
      continue;
    }
    if (code === 22) {
      state.fontWeight = undefined;
      continue;
    }
    if (code === 39) {
      state.color = undefined;
      continue;
    }
    if (code === 49) {
      state.backgroundColor = undefined;
      continue;
    }
    if (code >= 30 && code <= 37) {
      applyAnsiColor(state, "fg", ANSI_FG[code - 30]);
      continue;
    }
    if (code >= 90 && code <= 97) {
      applyAnsiColor(state, "fg", ANSI_FG_BRIGHT[code - 90]);
      continue;
    }
    if (code >= 40 && code <= 47) {
      applyAnsiColor(state, "bg", ANSI_BG[code - 40]);
      continue;
    }
    if (code >= 100 && code <= 107) {
      applyAnsiColor(state, "bg", ANSI_BG_BRIGHT[code - 100]);
      continue;
    }
    if ((code === 38 || code === 48) && index + 1 < codes.length) {
      const target = code === 38 ? "fg" : "bg";
      const mode = codes[index + 1];
      if (mode === 5 && index + 2 < codes.length) {
        applyAnsiColor(state, target, ansi256Color(codes[index + 2] ?? 0));
        index += 2;
        continue;
      }
      if (mode === 2 && index + 4 < codes.length) {
        const r = Math.max(0, Math.min(255, codes[index + 2] ?? 0));
        const g = Math.max(0, Math.min(255, codes[index + 3] ?? 0));
        const b = Math.max(0, Math.min(255, codes[index + 4] ?? 0));
        applyAnsiColor(state, target, `rgb(${r}, ${g}, ${b})`);
        index += 4;
      }
    }
  }
}

export function stripAnsi(input: string): string {
  return input.replace(ANSI_CONTROL_PATTERN, "");
}

export function parseAnsiText(input: string): ParsedAnsiText {
  const segments: AnsiSegment[] = [];
  const state: AnsiState = {};
  let plainText = "";
  let lastIndex = 0;

  input.replace(ANSI_CONTROL_PATTERN, (match, codes: string, _intermediate: string, final: string, offset: number) => {
    if (offset > lastIndex) {
      const text = input.slice(lastIndex, offset);
      plainText += text;
      if (text.length > 0) {
        segments.push({
          text,
          style: cloneState(state)
        });
      }
    }
    if (final === "m") {
      applySgrCodes(state, codes);
    }
    lastIndex = offset + match.length;
    return match;
  });

  if (lastIndex < input.length) {
    const text = input.slice(lastIndex);
    plainText += text;
    if (text.length > 0) {
      segments.push({
        text,
        style: cloneState(state)
      });
    }
  }

  return {
    plainText,
    segments
  };
}
