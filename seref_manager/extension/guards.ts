/** The package's one object guard: narrows to a record whose fields are still `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
