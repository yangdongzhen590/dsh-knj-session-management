/**
 * 客户端 bundle 的构建标记，由 tsdown 的 `define` 在打包时替换成构建时间。
 *
 * 为什么需要它：client bundle 是**页面加载时**取的（不是每次渲染都读盘），改了 bundle 必须刷新页面
 * 才生效；一旦出现"改了怎么没生效"，只能靠一个可见标记判断当前界面到底是哪一版产物——否则只能在
 * "代码没写对"和"页面没刷新"之间猜（本项目踩过一次）。面板把它显示在提示行末尾。
 *
 * 用 `typeof` 兜底：万一这段代码没经过 tsdown（例如直接用 tsc 产出），也不会 ReferenceError 打崩面板。
 */
declare const __KNJ_SM_BUILD__: string

export const CLIENT_BUILD: string = typeof __KNJ_SM_BUILD__ === 'string' ? __KNJ_SM_BUILD__ : 'dev'
