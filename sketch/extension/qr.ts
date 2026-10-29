/**
 * Minimal QR code encoder: byte mode, error-correction level M, versions 1–10
 * (up to 213 bytes, plenty for a LAN URL). Algorithm follows Nayuki's
 * reference implementation (MIT). Renders to SVG.
 */

const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_BITS_M = 0;
const MAX_VERSION = 10;

const bit = (x: number, i: number): boolean => ((x >>> i) & 1) !== 0;

function rawDataModules(ver: number): number {
	let result = (16 * ver + 128) * ver + 64;
	if (ver >= 2) {
		const numAlign = Math.floor(ver / 7) + 2;
		result -= (25 * numAlign - 10) * numAlign - 55;
		if (ver >= 7) result -= 36;
	}
	return result;
}

const dataCodewords = (ver: number): number =>
	Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

function gfMul(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z;
}

function rsDivisor(degree: number): number[] {
	const result: number[] = new Array(degree - 1).fill(0);
	result.push(1);
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = gfMul(result[j], root);
			if (j + 1 < result.length) result[j] ^= result[j + 1];
		}
		root = gfMul(root, 0x02);
	}
	return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
	const result = divisor.map(() => 0);
	for (const b of data) {
		const factor = b ^ (result.shift() as number);
		result.push(0);
		divisor.forEach((coef, i) => {
			result[i] ^= gfMul(coef, factor);
		});
	}
	return result;
}

function addEccAndInterleave(data: number[], ver: number): number[] {
	const numBlocks = NUM_BLOCKS[ver];
	const eccLen = ECC_PER_BLOCK[ver];
	const raw = Math.floor(rawDataModules(ver) / 8);
	const numShort = numBlocks - (raw % numBlocks);
	const shortLen = Math.floor(raw / numBlocks);
	const divisor = rsDivisor(eccLen);
	const blocks: number[][] = [];
	for (let i = 0, k = 0; i < numBlocks; i++) {
		const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
		k += dat.length;
		const ecc = rsRemainder(dat, divisor);
		if (i < numShort) dat.push(0);
		blocks.push(dat.concat(ecc));
	}
	const result: number[] = [];
	for (let i = 0; i < blocks[0].length; i++) {
		blocks.forEach((block, j) => {
			if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]);
		});
	}
	return result;
}

function maskBit(mask: number, x: number, y: number): boolean {
	switch (mask) {
		case 0: return (x + y) % 2 === 0;
		case 1: return y % 2 === 0;
		case 2: return x % 3 === 0;
		case 3: return (x + y) % 3 === 0;
		case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
		case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
		case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
		default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
	}
}

class Matrix {
	readonly size: number;
	readonly dark: boolean[][];
	readonly fn: boolean[][];

	constructor(readonly ver: number) {
		this.size = ver * 4 + 17;
		this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
		this.fn = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
	}

	setFn(x: number, y: number, dark: boolean): void {
		this.dark[y][x] = dark;
		this.fn[y][x] = true;
	}

	drawFunctionPatterns(): void {
		const { size } = this;
		for (let i = 0; i < size; i++) {
			this.setFn(6, i, i % 2 === 0);
			this.setFn(i, 6, i % 2 === 0);
		}
		this.drawFinder(3, 3);
		this.drawFinder(size - 4, 3);
		this.drawFinder(3, size - 4);
		const align = this.alignmentPositions();
		const last = align.length - 1;
		for (let i = 0; i <= last; i++) {
			for (let j = 0; j <= last; j++) {
				if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
				for (let dy = -2; dy <= 2; dy++) {
					for (let dx = -2; dx <= 2; dx++) {
						this.setFn(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
					}
				}
			}
		}
		this.drawFormatBits(0);
		this.drawVersion();
	}

	drawFinder(x: number, y: number): void {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				const xx = x + dx;
				const yy = y + dy;
				if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFn(xx, yy, dist !== 2 && dist !== 4);
			}
		}
	}

	alignmentPositions(): number[] {
		if (this.ver === 1) return [];
		const numAlign = Math.floor(this.ver / 7) + 2;
		const step = Math.floor((this.ver * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
		const result = [6];
		for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
		return result;
	}

	drawFormatBits(mask: number): void {
		const { size } = this;
		const data = (FORMAT_BITS_M << 3) | mask;
		let rem = data;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const bits = ((data << 10) | rem) ^ 0x5412;
		for (let i = 0; i <= 5; i++) this.setFn(8, i, bit(bits, i));
		this.setFn(8, 7, bit(bits, 6));
		this.setFn(8, 8, bit(bits, 7));
		this.setFn(7, 8, bit(bits, 8));
		for (let i = 9; i < 15; i++) this.setFn(14 - i, 8, bit(bits, i));
		for (let i = 0; i < 8; i++) this.setFn(size - 1 - i, 8, bit(bits, i));
		for (let i = 8; i < 15; i++) this.setFn(8, size - 15 + i, bit(bits, i));
		this.setFn(8, size - 8, true);
	}

	drawVersion(): void {
		if (this.ver < 7) return;
		let rem = this.ver;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const bits = (this.ver << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const a = this.size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			this.setFn(a, b, bit(bits, i));
			this.setFn(b, a, bit(bits, i));
		}
	}

	drawCodewords(data: number[]): void {
		const { size } = this;
		let i = 0;
		for (let right = size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < size; vert++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? size - 1 - vert : vert;
					if (!this.fn[y][x] && i < data.length * 8) {
						this.dark[y][x] = bit(data[i >>> 3], 7 - (i & 7));
						i++;
					}
				}
			}
		}
	}

	applyMask(mask: number): void {
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				if (!this.fn[y][x] && maskBit(mask, x, y)) this.dark[y][x] = !this.dark[y][x];
			}
		}
	}

	/** ISO 18004 penalty rules 1, 2 and 4, plus a plain finder-lookalike scan for rule 3. */
	penalty(): number {
		const { size, dark } = this;
		let score = 0;
		const finderA = [true, false, true, true, true, false, true, false, false, false, false];
		const finderB = [...finderA].reverse();
		const line = (get: (i: number) => boolean): void => {
			let run = 1;
			for (let i = 1; i <= size; i++) {
				if (i < size && get(i) === get(i - 1)) {
					run++;
				} else {
					if (run >= 5) score += 3 + (run - 5);
					run = 1;
				}
			}
			for (let i = 0; i + 11 <= size; i++) {
				let a = true;
				let b = true;
				for (let k = 0; k < 11; k++) {
					const v = get(i + k);
					if (v !== finderA[k]) a = false;
					if (v !== finderB[k]) b = false;
				}
				if (a) score += 40;
				if (b) score += 40;
			}
		};
		for (let y = 0; y < size; y++) line(x => dark[y][x]);
		for (let x = 0; x < size; x++) line(y => dark[y][x]);
		let darkCount = 0;
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				if (dark[y][x]) darkCount++;
				if (x + 1 < size && y + 1 < size) {
					const c = dark[y][x];
					if (c === dark[y][x + 1] && c === dark[y + 1][x] && c === dark[y + 1][x + 1]) score += 3;
				}
			}
		}
		const total = size * size;
		score += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;
		return score;
	}
}

export function encodeQr(text: string): boolean[][] {
	const bytes = [...new TextEncoder().encode(text)];
	let ver = 1;
	for (; ver <= MAX_VERSION; ver++) {
		const countBits = ver <= 9 ? 8 : 16;
		if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
	}
	if (ver > MAX_VERSION) throw new Error(`QR payload too long (${bytes.length} bytes)`);

	const bits: boolean[] = [];
	const push = (val: number, len: number): void => {
		for (let i = len - 1; i >= 0; i--) bits.push(bit(val, i));
	};
	push(0b0100, 4);
	push(bytes.length, ver <= 9 ? 8 : 16);
	for (const b of bytes) push(b, 8);
	const capacity = dataCodewords(ver) * 8;
	push(0, Math.min(4, capacity - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

	const data: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let b = 0;
		for (let k = 0; k < 8; k++) b = (b << 1) | (bits[i + k] ? 1 : 0);
		data.push(b);
	}

	const m = new Matrix(ver);
	m.drawFunctionPatterns();
	m.drawCodewords(addEccAndInterleave(data, ver));
	let bestMask = 0;
	let bestScore = Infinity;
	for (let mask = 0; mask < 8; mask++) {
		m.applyMask(mask);
		m.drawFormatBits(mask);
		const score = m.penalty();
		if (score < bestScore) {
			bestScore = score;
			bestMask = mask;
		}
		m.applyMask(mask);
	}
	m.applyMask(bestMask);
	m.drawFormatBits(bestMask);
	return m.dark;
}

export function qrSvg(text: string, border = 4): string {
	const modules = encodeQr(text);
	const n = modules.length + border * 2;
	let d = "";
	modules.forEach((row, y) => {
		row.forEach((on, x) => {
			if (on) d += `M${x + border},${y + border}h1v1h-1z`;
		});
	});
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
