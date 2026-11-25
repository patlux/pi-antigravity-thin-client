import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

/**
 * All interface texts of the fork are English. Upstream writes its texts in Chinese and
 * the fork's first texts were German, so an upstream merge or a new feature can bring
 * such texts back. Comments are not checked; only string and template literals in src/.
 */
const SRC = path.join(import.meta.dirname, "..", "src");
const CHINESE = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
const GERMAN = /[äöüÄÖÜß„“]/;

function sourceFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(full);
		return entry.name.endsWith(".ts") ? [full] : [];
	});
}

function nonEnglishLiterals(file: string): string[] {
	const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
	const found: string[] = [];
	const visit = (node: ts.Node): void => {
		if (
			ts.isStringLiteral(node) ||
			ts.isNoSubstitutionTemplateLiteral(node) ||
			ts.isTemplateHead(node) ||
			ts.isTemplateMiddle(node) ||
			ts.isTemplateTail(node)
		) {
			if (CHINESE.test(node.text) || GERMAN.test(node.text)) {
				const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
				found.push(`${path.relative(SRC, file)}:${line + 1}: ${node.text.slice(0, 80)}`);
			}
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return found;
}

describe("interface language", () => {
	it("keeps every string literal in src/ free of Chinese and German text", () => {
		const offenders = sourceFiles(SRC).flatMap(nonEnglishLiterals);
		assert.deepEqual(offenders, [], `translate these texts to English:\n${offenders.join("\n")}`);
	});
});
