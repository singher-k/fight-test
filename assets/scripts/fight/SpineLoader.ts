import { assetManager, sp } from 'cc';

/**
 * Spine 资源加载器
 *
 * assets/spine 已被标记为 Asset Bundle（bundleName = spine），
 * 因此这里按 Bundle 内路径加载，不依赖 resources 目录。
 */
export class SpineLoader {
    private static _bundle: any = null;
    private static _loading: Promise<any> | null = null;
    private static _cache = new Map<string, sp.SkeletonData>();

    /** 加载 / 复用 spine Bundle */
    public static async ensureBundle (): Promise<any> {
        if (SpineLoader._bundle) return SpineLoader._bundle;

        const existed = assetManager.getBundle('spine');
        if (existed) {
            SpineLoader._bundle = existed;
            return existed;
        }

        if (!SpineLoader._loading) {
            SpineLoader._loading = new Promise((resolve, reject) => {
                assetManager.loadBundle('spine', (err, bundle) => {
                    if (err) {
                        console.error('[SpineLoader] 加载 Bundle "spine" 失败：', err);
                        SpineLoader._loading = null;
                        reject(err);
                        return;
                    }
                    SpineLoader._bundle = bundle;
                    resolve(bundle);
                });
            });
        }
        return SpineLoader._loading;
    }

    /** 按 Bundle 内路径加载 SkeletonData，并做内存缓存 */
    public static async load (path: string): Promise<sp.SkeletonData> {
        const cached = SpineLoader._cache.get(path);
        if (cached && cached.isValid) return cached;

        const bundle = await SpineLoader.ensureBundle();
        const data = await new Promise<sp.SkeletonData>((resolve, reject) => {
            bundle.load(path, sp.SkeletonData, (err: Error | null, asset: sp.SkeletonData) => {
                if (err) {
                    console.error(`[SpineLoader] 加载 ${path} 失败：`, err);
                    reject(err);
                    return;
                }
                resolve(asset);
            });
        });

        SpineLoader._cache.set(path, data);
        return data;
    }

    /** 读取骨骼内实际存在的动画名（用于自检，失败时返回空数组） */
    public static getAnimationNames (data: sp.SkeletonData): string[] {
        try {
            const runtime: any = (data as any).getRuntimeData ? (data as any).getRuntimeData() : null;
            const anims = runtime && runtime.animations ? runtime.animations : null;
            if (anims && anims.length) return anims.map((a: any) => a.name as string);
        } catch (e) {
            /* 忽略：不同版本内部结构不同 */
        }
        return [];
    }

    /**
     * 释放缓存里除 keep 之外的角色资源
     *
     * ★ 为什么需要：角色池现在有 13 个，其中 6 个是 4096×4096 图集，
     *   解码成 RGBA8888 单张就是 64MB。循环战斗每场换敌会把用过的角色
     *   一直留在缓存里，几十场之后就是 GB 级显存，移动端必崩。
     *   因此每场开始后按「当前在场的两个角色」做一次淘汰。
     *
     * @param keep 需要保留的 bundle 内路径（如 'zhaoyun/zhaoyun'）
     */
    public static releaseExcept (keep: string[]): void {
        if (SpineLoader._cache.size === 0) return;
        const bundle: any = SpineLoader._bundle;
        const keepSet = new Set(keep);

        const drop: string[] = [];
        SpineLoader._cache.forEach((_v, k) => {
            if (!keepSet.has(k)) drop.push(k);
        });
        if (drop.length === 0) return;

        for (const p of drop) {
            SpineLoader._cache.delete(p);
            try {
                if (bundle) bundle.release(p, sp.SkeletonData);
            } catch (e) {
                console.warn(`[SpineLoader] 释放 ${p} 时出错：`, e);
            }
        }
        console.log('[SpineLoader] 已释放未使用角色资源：', drop.join(', '));
    }
}
