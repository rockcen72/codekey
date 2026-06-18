"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../services/api");
const storage_1 = require("../../services/storage");
const auth_1 = require("../../services/auth");
const crypto_1 = require("../../utils/crypto");
const app = getApp();
Page({
    data: {
        code: '',
        status: 'binding',
        errorMsg: '',
    },
    onLoad(query) {
        // Feishu deep link encodes query params in a single `query` string.
        // parseFeishuQuery extracts them when present, falling back to direct props.
        function parseFeishuQuery(q) {
            if (q && typeof q.query === 'string') {
                const pairs = q.query.split('&');
                const result = {};
                for (const p of pairs) {
                    const eq = p.indexOf('=');
                    if (eq > 0)
                        result[decodeURIComponent(p.slice(0, eq))] = decodeURIComponent(p.slice(eq + 1));
                }
                return result;
            }
            return q || {};
        }
        const q = parseFeishuQuery(query);
        const code = q.code || '';
        const keyId = q.key_id || '';
        const contentKey = q.content_key || '';
        const platform = q.platform === 'wechat' ? 'wechat' : 'feishu';
        this.setData({ code, platform });
        this.confirmBind(code, platform, keyId, contentKey);
    },
    async confirmBind(code, platform, keyId, contentKey) {
        this.setData({ status: 'binding', errorMsg: '' });
        try {
            const api = (0, api_1.createApi)((0, storage_1.getServerUrl)());
            // Generate ECDH key pair for 绑定码 (no contentKey in URL)
            let phonePublicKeyHex;
            let ecdhPrivateKeyHex;
            if (!keyId || !contentKey) {
                try {
                    const kp = (0, crypto_1.generateEcdhKeyPair)();
                    phonePublicKeyHex = kp.publicKeyHex;
                    ecdhPrivateKeyHex = kp.privateKeyHex;
                    console.log('[bind] generated ECDH key pair for 绑定码 E2E');
                }
                catch (e) {
                    console.warn('[bind] ECDH not available, proceeding without E2E:', e);
                }
            }
            const result = await api.confirmCode(code, platform, phonePublicKeyHex);
            (0, storage_1.saveAuth)(result.clientToken, result.deviceId);
            // Save contentKey: priority QR > ECDH > none
            if (keyId && contentKey) {
                (0, storage_1.saveContentKey)(contentKey, keyId);
            }
            else if (ecdhPrivateKeyHex && result.e2eAvailable && result.desktopPublicKeyHex) {
                try {
                    const material = (0, crypto_1.deriveEcdhKeyMaterial)(ecdhPrivateKeyHex, result.desktopPublicKeyHex);
                    (0, storage_1.saveContentKey)(material.contentKeyHex, material.keyId);
                    console.log('[bind] derived ECDH contentKey for 绑定码');
                }
                catch (e) {
                    console.warn('[bind] ECDH derivation failed:', e);
                }
            }
            // Wait for user/device binding before leaving this page. Subscription
            // state is merged during claim-device; redirecting earlier can make the
            // next page briefly render the old/free entitlement.
            await (0, auth_1.ensureUserToken)().catch((err) => {
                console.warn('[bind] ensureUserToken failed:', err);
            });
            app.destroyWs();
            app.initWs();
            this.setData({ status: 'success' });
            setTimeout(() => {
                tt.reLaunch({ url: '/pages/sessions/sessions' });
            }, 1500);
        }
        catch (err) {
            const msg = err?.error === 'RATE_LIMITED'
                ? '操作太频繁，请稍后再试'
                : err?.error === 'invalid or expired code'
                    ? '配对码已过期或已使用'
                    : '绑定失败：' + (err?.error || '未知错误');
            this.setData({ status: 'failed', errorMsg: msg });
        }
    },
    retry() {
        tt.navigateBack();
    },
});
