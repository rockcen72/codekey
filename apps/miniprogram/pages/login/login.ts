// pages/login/login — 隐形中转页（兼容旧体验版二维码 path=pages/login/login）
//
// 1.2.x 起，小程序首页改为 pages/sessions/sessions，配对入口下沉到 settings。
// 但旧的体验版二维码 / 微信后台默认路径仍可能写死 pages/login/login，
// 所以这里保留一个最小化的中转 Page：onLoad 立即 reLaunch 到 sessions。
//
// 此页面：
//   - 不渲染任何配对/扫码 UI（避免被微信审核认为是"打开即扫码登录"）
//   - 不再依赖 hasAuth / ensureUserToken（那些逻辑已转到 sessions/settings）
//   - 仅作为路由跳板存在
Page({
  onLoad() {
    wx.reLaunch({ url: '/pages/sessions/sessions' });
  },
});
