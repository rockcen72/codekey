import { createApi } from '../../services/api';
import { saveAuth, saveContentKey, getServerUrl } from '../../services/storage';
import { ensureUserToken } from '../../services/auth';
import { generateEcdhKeyPair, deriveEcdhKeyMaterial } from '../../utils/crypto';

const app = getApp<any>();

Page({
  data: {
    code: '',
    status: 'binding' as 'binding' | 'success' | 'failed',
    errorMsg: '',
  },

  onLoad(query: any) {
    // Feishu deep link encodes query params in a single `query` string.
    // parseFeishuQuery extracts them when present, falling back to direct props.
    function parseFeishuQuery(q: any): Record<string, string> {
      if (q && typeof q.query === 'string') {
        const pairs = q.query.split('&');
        const result: Record<string, string> = {};
        for (const p of pairs) {
          const eq = p.indexOf('=');
          if (eq > 0) result[decodeURIComponent(p.slice(0, eq))] = decodeURIComponent(p.slice(eq + 1));
        }
        return result;
      }
      return q || {};
    }
    const q = parseFeishuQuery(query);
    const code = q.code || '';
    const keyId = q.key_id || '';
    const contentKey = q.content_key || '';
    const platform: 'wechat' | 'feishu' = q.platform === 'wechat' ? 'wechat' : 'feishu';
    this.setData({ code, platform });
    this.confirmBind(code, platform, keyId, contentKey);
  },

  async confirmBind(code: string, platform: 'wechat' | 'feishu', keyId?: string, contentKey?: string) {
    this.setData({ status: 'binding', errorMsg: '' });
    try {
      const api = createApi(getServerUrl());

      // Generate ECDH key pair for 绑定码 (no contentKey in URL)
      let phonePublicKeyHex: string | undefined;
      let ecdhPrivateKeyHex: string | undefined;
      if (!keyId || !contentKey) {
        try {
          const kp = generateEcdhKeyPair();
          phonePublicKeyHex = kp.publicKeyHex;
          ecdhPrivateKeyHex = kp.privateKeyHex;
          console.log('[bind] generated ECDH key pair for 绑定码 E2E');
        } catch (e) {
          console.warn('[bind] ECDH not available, proceeding without E2E:', e);
        }
      }

      const result = await api.confirmCode(code, platform, phonePublicKeyHex);
      saveAuth(result.clientToken, result.deviceId);

      // Save contentKey: priority QR > ECDH > none
      if (keyId && contentKey) {
        saveContentKey(contentKey, keyId);
      } else if (ecdhPrivateKeyHex && result.e2eAvailable && result.desktopPublicKeyHex) {
        try {
          const material = deriveEcdhKeyMaterial(ecdhPrivateKeyHex, result.desktopPublicKeyHex);
          saveContentKey(material.contentKeyHex, material.keyId);
          console.log('[bind] derived ECDH contentKey for 绑定码');
        } catch (e) {
          console.warn('[bind] ECDH derivation failed:', e);
        }
      }
      // Wait for user/device binding before leaving this page. Subscription
      // state is merged during claim-device; redirecting earlier can make the
      // next page briefly render the old/free entitlement.
      await ensureUserToken().catch((err) => {
        console.warn('[bind] ensureUserToken failed:', err);
      });
      app.destroyWs();
      app.initWs();
      this.setData({ status: 'success' });
      setTimeout(() => {
        tt.reLaunch({ url: '/pages/sessions/sessions' });
      }, 1500);
    } catch (err: any) {
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
