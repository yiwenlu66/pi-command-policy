import type { Word, WordPart } from "unbash";

/** True when a word part's text is fully known without expansion or execution. */
export function isStaticPart(part: WordPart): boolean {
	switch (part.type) {
		case "Literal":
		case "SingleQuoted":
		case "AnsiCQuoted":
			return true;
		case "DoubleQuoted":
			return part.parts.every(isStaticPart);
		default:
			return false;
	}
}

/** The literal text of a word whose parts are all statically known, else undefined. */
export function literal(word: Word | undefined): string | undefined {
	if (!word || (word.parts && !word.parts.every(isStaticPart))) return undefined;
	return word.value;
}
