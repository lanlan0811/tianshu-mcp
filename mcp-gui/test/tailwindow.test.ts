import { describe, expect, it } from "vitest";
import { byteLength, sliceRangeByBytes, sliceTailByBytes } from "@/core/bytes";
import {
  DEFAULT_WINDOW_BYTES,
  hasMoreBefore,
  hasPendingNewContent,
  loadedRatio,
  planInitialWindow,
  planLoadMore,
} from "@/core/tailwindow";

describe("planInitialWindow", () => {
  it("文件大于窗口时只取尾部", () => {
    expect(planInitialWindow(1000, 400)).toEqual({ from: 600, to: 1000 });
  });

  it("文件小于窗口时从头读（不出现负偏移）", () => {
    expect(planInitialWindow(100, 400)).toEqual({ from: 0, to: 100 });
  });

  it("空文件与 0 窗口边界", () => {
    expect(planInitialWindow(0, 400)).toEqual({ from: 0, to: 0 });
  });

  it("默认窗口为 64 KiB（与后端 readRecentAgentEvents 思路一致）", () => {
    expect(DEFAULT_WINDOW_BYTES).toBe(64 * 1024);
  });
});

describe("planLoadMore", () => {
  it("向前加载一块", () => {
    expect(planLoadMore(600, 200)).toEqual({ from: 400, to: 600 });
  });

  it("到文件头时返回 null（UI 据此禁用按钮）", () => {
    expect(planLoadMore(0, 200)).toBeNull();
  });

  it("接近文件头时收敛到 0", () => {
    expect(planLoadMore(50, 200)).toEqual({ from: 0, to: 50 });
  });
});

describe("loadedRatio / hasMoreBefore / 新内容提示", () => {
  it("占比与是否还有更早内容", () => {
    expect(loadedRatio(600, 1000, 1000)).toBeCloseTo(0.4);
    expect(loadedRatio(0, 0, 0)).toBe(1);
    expect(hasMoreBefore(600)).toBe(true);
    expect(hasMoreBefore(0)).toBe(false);
  });

  it("非跟随时文件增长 → 提示有新内容；跟随时不提示", () => {
    expect(hasPendingNewContent(1000, 1200, false)).toBe(true);
    expect(hasPendingNewContent(1000, 1200, true)).toBe(false);
  });
});

describe("字节切片", () => {
  it("byteLength 按 UTF-8 计（中文 3 字节）", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("中")).toBe(3);
  });

  it("sliceTailByBytes 返回尾部窗口与总字节数", () => {
    const text = "0123456789";
    const slice = sliceTailByBytes(text, 4);
    expect(slice.text).toBe("6789");
    expect(slice.fromByte).toBe(6);
    expect(slice.totalBytes).toBe(10);
  });

  it("切片切断多字节字符时不产生替换字符", () => {
    const text = "中文中文";
    const slice = sliceTailByBytes(text, 7);
    // 尾部 7 字节起点落在「文」的第三字节上，边界残片被裁掉，留下完整的「中文」。
    expect(slice.text).toBe("中文");
    expect(slice.text).not.toContain("\uFFFD");
  });

  it("sliceRangeByBytes 越界自动收敛", () => {
    const slice = sliceRangeByBytes("abcdef", -5, 999);
    expect(slice.text).toBe("abcdef");
    expect(slice.fromByte).toBe(0);
    expect(slice.toByte).toBe(6);
  });
});