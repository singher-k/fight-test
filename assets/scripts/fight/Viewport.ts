import { Rect, sys, view } from 'cc';

/** 设计分辨率（与 project.json 的 designResolution 一致），仅作取不到可视尺寸时的兜底 */
export const DESIGN_W = 720;
export const DESIGN_H = 1280;

/** 屏幕四边需要避让的距离（设计单位）：刘海、圆角、Home 指示条 */
export interface SafeInsets {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

/** 当前可视区域信息 */
export interface Viewport {
    /** 可视宽度（设计单位）。fitHeight 下高度固定、宽度随设备变化 */
    width: number;
    height: number;
    halfW: number;
    halfH: number;
    safe: SafeInsets;
}

/**
 * 读取当前可视尺寸与安全区内缩。
 *
 * 项目用 fitHeight（720×1280），所以：
 *   - height 恒为 1280
 *   - width 随屏幕比例变化（iPhone 约 591，16:9 恰为 720，平板可达 1706）
 * 因此所有横向布局必须以 width / halfW 为基准，纵向可以按 height 为基准。
 */
export function getViewport (): Viewport {
    let w = DESIGN_W;
    let h = DESIGN_H;

    try {
        const s = view.getVisibleSize();
        if (s && s.width > 1 && s.height > 1) {
            w = s.width;
            h = s.height;
        }
    } catch (e) { /* 引擎未初始化完成时忽略，退回设计分辨率 */ }

    let top = 0;
    let bottom = 0;
    let left = 0;
    let right = 0;

    try {
        const r: Rect = sys.getSafeAreaRect();
        if (r && r.width > 1 && r.height > 1) {
            // getSafeAreaRect 返回的是设计分辨率坐标、原点在可视区左下角
            top = Math.max(0, h - r.y - r.height);
            bottom = Math.max(0, r.y);
            left = Math.max(0, r.x);
            right = Math.max(0, w - r.x - r.width);

            // 保险：异常值（部分平台返回整屏或空矩形）不要破坏布局
            if (top > h * 0.12) top = 0;
            if (bottom > h * 0.12) bottom = 0;
            if (left > w * 0.2) left = 0;
            if (right > w * 0.2) right = 0;
        }
    } catch (e) { /* 平台不支持安全区，全部按 0 处理 */ }

    return {
        width: w,
        height: h,
        halfW: w / 2,
        halfH: h / 2,
        safe: { top, bottom, left, right },
    };
}

/** 监听画布尺寸变化（窗口缩放、横竖屏切换、浏览器地址栏收起等） */
export function onResize (cb: () => void, target?: unknown): void {
    view.on('canvas-resize', cb, target);
    view.on('design-resolution-changed', cb, target);
}

export function offResize (cb: () => void, target?: unknown): void {
    view.off('canvas-resize', cb, target);
    view.off('design-resolution-changed', cb, target);
}

export function clamp (v: number, min: number, max: number): number {
    return v < min ? min : (v > max ? max : v);
}
