/**
 * UTF-8 字节窗口工具（纯函数）。
 *
 * 用途：mock 数据出口与前端展示口径都需要「按字节切片」，
 * 与后端 `tail.rs` 的字节偏移语义保持一致（偏移是**字节**而非字符）。
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

export function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** 去掉切片边界产生的替换字符（多字节字符被切断时的正常现象） */
function stripBoundaryReplacement(text: string): string {
  return text.replace(/^\uFFFD+/, "").replace(/\uFFFD+$/, "");
}

export interface ByteSlice {
  text: string;
  fromByte: number;
  toByte: number;
  totalBytes: number;
}

/** 取尾部窗口 [max(0, total-maxBytes), total) */
export function sliceTailByBytes(text: string, maxBytes: number): ByteSlice {
  const buf = encoder.encode(text);
  const totalBytes = buf.byteLength;
  const win = Math.max(1, maxBytes);
  const fromByte = Math.max(0, totalBytes - win);
  const slice = buf.subarray(fromByte, totalBytes);
  return {
    text: stripBoundaryReplacement(decoder.decode(slice)),
    fromByte,
    toByte: totalBytes,
    totalBytes,
  };
}

/** 取绝对字节区间 [fromByte, toByte)；越界自动收敛 */
export function sliceRangeByBytes(text: string, fromByte: number, toByte: number): ByteSlice {
  const buf = encoder.encode(text);
  const totalBytes = buf.byteLength;
  const from = Math.max(0, Math.min(fromByte, totalBytes));
  const to = Math.max(from, Math.min(toByte, totalBytes));
  const slice = buf.subarray(from, to);
  return {
    text: stripBoundaryReplacement(decoder.decode(slice)),
    fromByte: from,
    toByte: to,
    totalBytes,
  };
}