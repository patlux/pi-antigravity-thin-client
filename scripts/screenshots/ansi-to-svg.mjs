/**
 * Renders a tmux pane capture (`capture-pane -e -N -p`) as an SVG terminal window.
 *
 * Every text run is placed on an exact cell grid and stretched to its cell width, so
 * the layout holds with whatever monospace font the renderer has. Cell widths come
 * from pi-tui, the same function Pi uses to lay out the screen.
 */
import { visibleWidth } from "@earendil-works/pi-tui";

const PALETTE_16 = [
	"#1c1c24", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#d4d4d8",
	"#5c6370", "#ef8b93", "#b5e08f", "#f0d395", "#82c2f5", "#d99ae8", "#7fd0d9", "#ffffff",
];

function color256(n) {
	if (n < 16) return PALETTE_16[n];
	if (n < 232) {
		const i = n - 16;
		const level = (v) => (v === 0 ? 0 : 55 + v * 40);
		const r = level(Math.floor(i / 36));
		const g = level(Math.floor((i % 36) / 6));
		const b = level(i % 6);
		return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
	}
	const gray = 8 + (n - 232) * 10;
	return `#${gray.toString(16).padStart(2, "0").repeat(3)}`;
}

const rgb = (r, g, b) => `#${[r, g, b].map((v) => Number(v).toString(16).padStart(2, "0")).join("")}`;

function applySgr(style, params) {
	const codes = params.length === 0 ? [0] : params;
	for (let i = 0; i < codes.length; i++) {
		const code = codes[i];
		if (code === 0) Object.assign(style, { fg: undefined, bg: undefined, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false });
		else if (code === 1) style.bold = true;
		else if (code === 2) style.dim = true;
		else if (code === 3) style.italic = true;
		else if (code === 4) style.underline = true;
		else if (code === 7) style.inverse = true;
		else if (code === 9) style.strike = true;
		else if (code === 22) Object.assign(style, { bold: false, dim: false });
		else if (code === 23) style.italic = false;
		else if (code === 24) style.underline = false;
		else if (code === 27) style.inverse = false;
		else if (code === 29) style.strike = false;
		else if (code >= 30 && code <= 37) style.fg = PALETTE_16[code - 30];
		else if (code >= 90 && code <= 97) style.fg = PALETTE_16[code - 90 + 8];
		else if (code >= 40 && code <= 47) style.bg = PALETTE_16[code - 40];
		else if (code >= 100 && code <= 107) style.bg = PALETTE_16[code - 100 + 8];
		else if (code === 39) style.fg = undefined;
		else if (code === 49) style.bg = undefined;
		else if (code === 38 || code === 48) {
			const key = code === 38 ? "fg" : "bg";
			if (codes[i + 1] === 5) {
				style[key] = color256(codes[i + 2]);
				i += 2;
			} else if (codes[i + 1] === 2) {
				style[key] = rgb(codes[i + 2], codes[i + 3], codes[i + 4]);
				i += 4;
			}
		}
	}
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Parses one captured line into cells: `{ text, width, style }`. tmux only emits
 * attribute changes, so the style carries over from the previous line.
 */
function parseLine(line, style) {
	const cells = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] === "\u001b") {
			const csi = /^\u001b\[([0-9;:]*)([A-Za-z])/.exec(line.slice(i));
			if (csi) {
				if (csi[2] === "m") applySgr(style, csi[1] ? csi[1].split(/[;:]/).map(Number) : []);
				i += csi[0].length;
				continue;
			}
			const osc = /^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/.exec(line.slice(i));
			i += osc ? osc[0].length : 1;
			continue;
		}
		let next = line.indexOf("\u001b", i);
		if (next < 0) next = line.length;
		for (const { segment } of segmenter.segment(line.slice(i, next))) {
			const width = Math.max(1, visibleWidth(segment));
			cells.push({ text: segment, width, style: { ...style } });
		}
		i = next;
	}
	return cells;
}

const escapeXml = (text) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * @param {string} ansi capture-pane output
 * @param {{ cols: number, title?: string, fg?: string, bg?: string, trimTop?: boolean }} options
 */
export function ansiToSvg(ansi, options) {
	const cols = options.cols;
	const fgDefault = options.fg ?? "#d4d4d8";
	const bgDefault = options.bg ?? "#1c1c24";
	const lines = ansi.replace(/\r/g, "").split("\n");
	while (lines.length > 0 && lines.at(-1).replace(/\u001b\[[0-9;:]*m/g, "").trim() === "") lines.pop();
	const style = {};
	const parsed = lines.map((line) => parseLine(line, style));
	const blank = (cells) => cells.every((cell) => cell.text === " " && !cell.style.bg);
	if (options.trimTop) {
		while (parsed.length > 0 && blank(parsed[0])) parsed.shift();
	}
	const cellWidth = 8.4;
	const lineHeight = 19;
	const padX = 18;
	const padTop = 44;
	const padBottom = 18;
	const width = Math.round(padX * 2 + cols * cellWidth);
	const height = Math.round(padTop + parsed.length * lineHeight + padBottom);

	const out = [];
	out.push(
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(options.title ?? "Pi terminal")}">`,
		`<title>${escapeXml(options.title ?? "Pi terminal")}</title>`,
		"<style>text{font-family:'JetBrains Mono NL','JetBrains Mono','SF Mono',Menlo,Consolas,'DejaVu Sans Mono','DejaVu Sans',monospace;font-size:14px;white-space:pre}.wide{font-family:'Noto Color Emoji','Apple Color Emoji','Segoe UI Emoji',sans-serif}</style>",
		`<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="${bgDefault}" stroke="#3a3a46"/>`,
		'<circle cx="20" cy="18" r="6" fill="#ff5f57"/><circle cx="40" cy="18" r="6" fill="#febc2e"/><circle cx="60" cy="18" r="6" fill="#28c840"/>',
	);
	if (options.title) {
		out.push(`<text x="${width / 2}" y="23" text-anchor="middle" fill="#8b8b99" style="font-size:12px">${escapeXml(options.title)}</text>`);
	}

	parsed.forEach((cells, row) => {
		const y = padTop + row * lineHeight;
		const baseline = y + lineHeight - 5;
		// Backgrounds: merge neighbouring cells with the same colour.
		let col = 0;
		let run;
		const flushBg = () => {
			if (run) out.push(`<rect x="${(padX + run.start * cellWidth).toFixed(1)}" y="${y}" width="${(run.cells * cellWidth).toFixed(1)}" height="${lineHeight}" fill="${run.color}"/>`);
			run = undefined;
		};
		for (const cell of cells) {
			const bg = cell.style.inverse ? (cell.style.fg ?? fgDefault) : cell.style.bg;
			if (bg && bg !== bgDefault) {
				if (run && run.color === bg && run.start + run.cells === col) run.cells += cell.width;
				else {
					flushBg();
					run = { start: col, cells: cell.width, color: bg };
				}
			} else flushBg();
			col += cell.width;
		}
		flushBg();

		// Text: runs of one style, stretched to their cells. Double-width cells (emoji)
		// get their own element with an emoji font; single-width symbols such as ⚙ or ✉
		// stay in the text font, as in a terminal.
		col = 0;
		let textRun;
		const styleKey = (s) => JSON.stringify([s.fg, s.bold, s.dim, s.italic, s.underline, s.inverse, s.strike, s.bg]);
		const flushText = () => {
			if (!textRun) return;
			const s = textRun.style;
			const fill = s.inverse ? (s.bg ?? bgDefault) : (s.fg ?? fgDefault);
			const attrs = [
				`x="${(padX + textRun.start * cellWidth).toFixed(1)}"`,
				`y="${baseline}"`,
				`fill="${fill}"`,
				s.bold ? 'font-weight="700"' : "",
				s.italic ? 'font-style="italic"' : "",
				s.dim ? 'opacity="0.62"' : "",
				s.underline ? 'text-decoration="underline"' : s.strike ? 'text-decoration="line-through"' : "",
			];
			if (textRun.wide) attrs.push('class="wide"');
			attrs.push(`textLength="${(textRun.cells * cellWidth).toFixed(1)}"`, 'lengthAdjust="spacingAndGlyphs"');
			out.push(`<text ${attrs.filter(Boolean).join(" ")}>${escapeXml(textRun.text)}</text>`);
			textRun = undefined;
		};
		for (const cell of cells) {
			if (cell.text === " " && !cell.style.underline && !cell.style.inverse) {
				flushText();
				col += cell.width;
				continue;
			}
			if (cell.width > 1) {
				flushText();
				textRun = { start: col, cells: cell.width, text: cell.text, style: cell.style, wide: true };
				flushText();
				col += cell.width;
				continue;
			}
			if (textRun && !textRun.wide && styleKey(textRun.style) === styleKey(cell.style) && textRun.start + textRun.cells === col) {
				textRun.text += cell.text;
				textRun.cells += cell.width;
			} else {
				flushText();
				textRun = { start: col, cells: cell.width, text: cell.text, style: cell.style, wide: false };
			}
			col += cell.width;
		}
		flushText();
	});
	out.push("</svg>");
	return `${out.join("\n")}\n`;
}
