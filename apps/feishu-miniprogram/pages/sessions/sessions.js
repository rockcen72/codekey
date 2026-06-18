"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("../../services/api");
const storage_1 = require("../../services/storage");
const subscription_1 = require("../../services/subscription");
const auth_1 = require("../../services/auth");
const app = getApp();
const AGENT_LABELS = {
    'claude-code': 'Claude Code',
    'claude-code-hook': 'Claude Code',
    'codex': 'Codex',
    'opencode': 'OpenCode',
};
function agentLabel(agentType) {
    return agentType ? (AGENT_LABELS[agentType] || agentType) : 'Agent';
}
function collectAgentTabs(sessions) {
    const seen = new Set();
    const tabs = [{ key: 'all', label: 'All' }];
    for (const s of sessions) {
        const key = s.agent_type || s.displayRuntime || 'unknown';
        if (!seen.has(key)) {
            seen.add(key);
            tabs.push({ key, label: agentLabel(key) });
        }
    }
    return tabs;
}
function filterSessionsByTab(sessions, tab) {
    return tab === 'all'
        ? sessions
        : sessions.filter(s => (s.agent_type || s.displayRuntime || 'unknown') === tab);
}
let _summaryTimers = {};
let _fetchSessionsTimer = null;
Page({
    data: {
        isPaired: false,
        sessions: [],
        filteredSessions: [],
        wsConnected: false,
        deviceOnline: true,
        pendingTotal: 0,
        activeTotal: 0,
        activeTab: 'all',
        agentTabs: [{ key: 'all', label: 'All' }],
        _swipedSessionId: null,
        // Subscription pill (top bar) — mirrors the data shape used in
        // pages/settings/settings.ts so the same quota_exceeded
        // listener can drive a refetch on any page. The pill is hidden
        // for unauthenticated / load_failed — those users can still
        // reach settings via the gear icon.
        subTier: 'unauthenticated',
        subPlan: null,
        subDaysRemaining: null,
        subIsExpiringSoon: false,
        subUsage: null,
        subQuotaState: 'hidden',
        subQuotaPercent: 0,
        subPillText: '',
        subPillClass: '',
    },
    onShow() {
        this.setData({ isPaired: (0, storage_1.hasAuth)() });
        if ((0, storage_1.hasAuth)()) {
            this._debouncedFetchSessions();
            this.fetchSubscription();
            this.subscribeWs();
            this._startPolling();
        }
        else {
            this.setData({
                sessions: [], filteredSessions: [],
                activeTotal: 0, pendingTotal: 0,
                subTier: 'unauthenticated',
            });
        }
    },
    onHide() {
        this.unsubscribeWs();
        this._stopPolling();
        for (const key of Object.keys(_summaryTimers)) {
            clearTimeout(_summaryTimers[key]);
            delete _summaryTimers[key];
        }
    },
    onUnload() {
        this.unsubscribeWs();
        this._stopPolling();
        for (const key of Object.keys(_summaryTimers)) {
            clearTimeout(_summaryTimers[key]);
            delete _summaryTimers[key];
        }
    },
    subscribeWs() {
        app.initWs();
        this._onEventPushBound = async (payload) => {
            if (payload.eventType === 'task_complete' && payload.sessionId) {
                await this.fetchSessions().catch(() => { });
                const patch = (s) => s.id === payload.sessionId ? { ...s, _taskHighlight: true } : s;
                this.setData({
                    sessions: this.data.sessions.map(patch),
                    filteredSessions: this.data.filteredSessions.map(patch),
                });
                if (_summaryTimers[payload.sessionId]) {
                    clearTimeout(_summaryTimers[payload.sessionId]);
                }
                _summaryTimers[payload.sessionId] = setTimeout(() => {
                    const reset = (s) => s.id === payload.sessionId ? { ...s, _taskHighlight: false } : s;
                    this.setData({
                        sessions: this.data.sessions.map(reset),
                        filteredSessions: this.data.filteredSessions.map(reset),
                    });
                    delete _summaryTimers[payload.sessionId];
                }, 2000);
            }
            else {
                this._debouncedFetchSessions();
            }
        };
        // WS events: update local list immediately, then refresh from server.
        this._onSessionRegisteredBound = (payload) => {
            const sid = payload.sessionId;
            if (!sid || this.data.sessions.some((s) => s.id === sid))
                return;
            const entry = { id: sid, status: 'active', agent_type: 'claude-code', displayTitle: '同步中...', displaySubtitle: 'claude-code', connected: true, pendingCount: 0, hasPending: false, metadata: {} };
            const sessions = [entry, ...this.data.sessions];
            this.setData({ sessions, activeTotal: sessions.filter((s) => s.connected).length });
            this._applyFilter(sessions);
            this._debouncedFetchSessions(); // background refresh for full data
        };
        this._onSessionDeactivatedWsBound = (payload) => {
            const sid = payload.sessionId;
            if (!sid)
                return;
            const sessions = this.data.sessions.filter((s) => s.id !== sid);
            this.setData({ sessions, activeTotal: sessions.filter((s) => s.connected).length });
            this._applyFilter(sessions);
            this._debouncedFetchSessions();
        };
        this._onWsConnectedBound = () => { this.setData({ wsConnected: true }); this._debouncedFetchSessions(); };
        this._onWsDisconnectedBound = () => this.setData({ wsConnected: false });
        this._onDeviceOfflineBound = () => { this.setData({ deviceOnline: false }); this._updateConnectedStates(false); };
        this._onDeviceOnlineBound = () => { this.setData({ deviceOnline: true }); this._updateConnectedStates(true); };
        this._onQuotaExceededBound = () => { this.fetchSubscription(); };
        app.onWsEvent('event_push', this._onEventPushBound);
        app.onWsEvent('session_registered', this._onSessionRegisteredBound);
        app.onWsEvent('session_deactivated', this._onSessionDeactivatedWsBound);
        app.onWsEvent('session_label_updated', this._onFetchSessionsBound);
        app.onWsEvent('ws_connected', this._onWsConnectedBound);
        app.onWsEvent('ws_disconnected', this._onWsDisconnectedBound);
        app.onWsEvent('device_offline', this._onDeviceOfflineBound);
        app.onWsEvent('device_online', this._onDeviceOnlineBound);
        app.onWsEvent('quota_exceeded', this._onQuotaExceededBound);
        this._onPairedChangedBound = () => {
            this.setData({ isPaired: (0, storage_1.hasAuth)() });
            if ((0, storage_1.hasAuth)())
                this._debouncedFetchSessions();
        };
        app.onWsEvent('paired_state_changed', this._onPairedChangedBound);
        if (app.globalData.wsConnected !== this.data.wsConnected) {
            this.setData({ wsConnected: app.globalData.wsConnected });
        }
    },
    unsubscribeWs() {
        if (this._onEventPushBound)
            app.offWsEvent('event_push', this._onEventPushBound);
        if (this._onWsConnectedBound)
            app.offWsEvent('ws_connected', this._onWsConnectedBound);
        if (this._onWsDisconnectedBound)
            app.offWsEvent('ws_disconnected', this._onWsDisconnectedBound);
        if (this._onDeviceOfflineBound)
            app.offWsEvent('device_offline', this._onDeviceOfflineBound);
        if (this._onDeviceOnlineBound)
            app.offWsEvent('device_online', this._onDeviceOnlineBound);
        if (this._onQuotaExceededBound)
            app.offWsEvent('quota_exceeded', this._onQuotaExceededBound);
        if (this._onSessionRegisteredBound)
            app.offWsEvent('session_registered', this._onSessionRegisteredBound);
        if (this._onSessionDeactivatedWsBound)
            app.offWsEvent('session_deactivated', this._onSessionDeactivatedWsBound);
        if (this._onFetchSessionsBound)
            app.offWsEvent('session_label_updated', this._onFetchSessionsBound);
        if (this._onPairedChangedBound) {
            app.offWsEvent('paired_state_changed', this._onPairedChangedBound);
            this._onPairedChangedBound = undefined;
        }
        this._onEventPushBound = undefined;
        this._onFetchSessionsBound = undefined;
        this._onSessionRegisteredBound = undefined;
        this._onSessionDeactivatedWsBound = undefined;
        this._onWsConnectedBound = undefined;
        this._onWsDisconnectedBound = undefined;
        this._onDeviceOfflineBound = undefined;
        this._onDeviceOnlineBound = undefined;
        this._onQuotaExceededBound = undefined;
    },
    _debouncedFetchSessions() {
        if (_fetchSessionsTimer) clearTimeout(_fetchSessionsTimer);
        _fetchSessionsTimer = setTimeout(() => {
            _fetchSessionsTimer = null;
            this.fetchSessions();
        }, 300);
    },

    _startPolling() { this._stopPolling(); this._pollTimer = setInterval(() => this.fetchSessions(), 5000); },
    _stopPolling() { if (this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = undefined;
    } },
    _updateConnectedStates(deviceOnline) {
        const sessions = this.data.sessions.map(s => ({ ...s, connected: s.status === 'active' && deviceOnline }));
        const activeTotal = sessions.filter(s => s.connected).length;
        this.setData({ sessions, activeTotal });
        this._applyFilter(sessions);
    },
    _applyFilter(sessions) {
        const tab = this.data.activeTab;
        const filtered = filterSessionsByTab(sessions, tab);
        this.setData({ filteredSessions: filtered });
    },
    onTabTap(e) {
        const activeTab = e.currentTarget.dataset.key;
        this.setData({
            activeTab,
            filteredSessions: filterSessionsByTab(this.data.sessions, activeTab),
        });
    },
    async fetchSessions() {
        if (!(0, storage_1.hasAuth)())
            return;
        try {
            const api = (0, api_1.createApi)((0, storage_1.getServerUrl)());
            const raw = await api.getSessions();
            const deviceOnline = this.data.deviceOnline;
            const sessions = raw.map((s) => {
                const pendingCount = Number(s.pendingCount || s.pending_count || 0);
                return {
                    ...s,
                    displayTitle: sessionTitle(s),
                    displaySubtitle: sessionSubtitle(s),
                    displayRuntime: s.metadata?.runtime || s.agent_type || 'agent',
                    displayAgentLabel: agentLabel(s.agent_type),
                    agentClass: agentColorClass(s.agent_type || s.metadata?.runtime),
                    displayClaudeId: (s.metadata?.claudeSessionId || '').slice(0, 8),
                    displayTime: this.formatTime(s.last_active_at),
                    pendingCount,
                    hasPending: pendingCount > 0,
                    connected: s.status === 'active' && deviceOnline,
                    swiped: false,
                };
            });
            const agentTabs = collectAgentTabs(sessions);
            const activeTab = agentTabs.some((tab) => tab.key === this.data.activeTab) ? this.data.activeTab : 'all';
            this.setData({
                sessions,
                filteredSessions: filterSessionsByTab(sessions, activeTab),
                agentTabs,
                activeTab,
                pendingTotal: sessions.reduce((sum, item) => sum + item.pendingCount, 0),
                activeTotal: sessions.filter((item) => item.connected).length,
            });
        }
        catch (err) {
            if (requestSeq !== this._sessionFetchSeq)
                return;
            console.error('[sessions] fetch error:', err);
        }
    },
    onTouchStart(e) { this._swipeStartX = e.touches[0].clientX; this._swipingId = e.currentTarget.dataset.id; },
    onTouchEnd(e) {
        if (!this._swipingId)
            return;
        const delta = e.changedTouches[0].clientX - this._swipeStartX;
        if (delta < -50)
            this._openSwipe(this._swipingId);
        else
            this._closeAllSwipes();
        this._swipeStartX = 0;
        this._swipingId = null;
    },
    _openSwipe(id) { this.setData({ sessions: this.data.sessions.map(s => ({ ...s, swiped: s.id === id })) }); },
    _closeAllSwipes() { this.setData({ sessions: this.data.sessions.map(s => ({ ...s, swiped: false })) }); },
    deleteSession(e) {
        const sessionId = e.currentTarget.dataset.id;
        const sessions = this.data.sessions;
        const session = sessions.find((s) => s.id === sessionId);
        if (!session)
            return;
        tt.showModal({
            title: '删除会话',
            content: '将从列表中移除此会话。如果会话仍处于连接状态，将同时解除关联。',
            success: (res) => {
                if (!res.confirm) {
                    this._closeAllSwipes();
                    return;
                }
                if (session.connected && app.globalData.wsConnected) {
                    app.sendWs({ type: 'detach_session', payload: { sessionId, reason: 'manual_detach' } });
                }
                (0, api_1.createApi)((0, storage_1.getServerUrl)()).hideSession(sessionId).catch(() => { });
                const updated = sessions.filter((s) => s.id !== sessionId);
                this.setData({ sessions: updated, pendingTotal: updated.reduce((sum, s) => sum + (s.pendingCount || 0), 0), activeTotal: updated.filter((s) => s.connected).length });
                this._applyFilter(updated);
                setTimeout(() => this._debouncedFetchSessions(), 2000);
            },
        });
    },
    openSession(e) { this._closeAllSwipes(); tt.navigateTo({ url: '/pages/session-detail/session-detail?id=' + e.currentTarget.dataset.id }); },
    goToSettings() { tt.navigateTo({ url: '/pages/settings/settings' }); },
    goToSettingsFromPill() { this.goToSettings(); },
    goToSettingsForPair() { tt.navigateTo({ url: '/pages/settings/settings' }); },
    async fetchSubscription() {
        // Pulls the per-user subscription so the top-bar pill can
        // render the current tier / quota state. Same shape as the
        // settings page, so we get the same normal/approaching/
        // exhausted cutoffs. Silently no-ops on auth/network failure
        // — the pill just stays hidden, which is correct.
        try {
            await (0, auth_1.ensureUserToken)();
            const sub = await (0, subscription_1.getSubscription)();
            const tier = sub.tier;
            const daysRemaining = sub.expiresAt
                ? Math.ceil((new Date(sub.expiresAt).getTime() - Date.now()) / 86400000)
                : null;
            const usage = tier === 'free' ? sub.usage : null;
            const subQuotaState = !usage
                ? 'hidden'
                : usage.used >= usage.limit
                    ? 'exhausted'
                    : usage.used >= Math.floor(usage.limit * 0.8)
                        ? 'approaching'
                        : 'normal';
            const subQuotaPercent = usage
                ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
                : 0;
            const subIsExpiringSoon = tier === 'paid'
                && daysRemaining != null
                && daysRemaining >= 0
                && daysRemaining <= 3;
            const subPillText = this._buildSubPillText(tier, sub.plan, daysRemaining, usage, subQuotaState, subIsExpiringSoon);
            const subPillClass = subIsExpiringSoon
                ? 'sub-pill-expiring'
                : `sub-pill-${subQuotaState === 'hidden' ? 'tier-' + tier : subQuotaState}`;
            this.setData({
                subTier: tier,
                subPlan: sub.plan,
                subDaysRemaining: daysRemaining,
                subIsExpiringSoon,
                subUsage: usage,
                subQuotaState,
                subQuotaPercent,
                subPillText,
                subPillClass,
            });
        }
        catch (err) {
            console.warn('[sessions] fetchSubscription failed:', err);
        }
    },
    _buildSubPillText(tier, plan, daysRemaining, usage, quotaState, isExpiringSoon = false) {
        // Compact text for the top-bar pill (≤ 8 Chinese chars or
        // ~12 Latin chars). Tapping the pill opens settings.
        if (tier === 'paid') {
            const planLabel = plan === 'yearly' ? '年付' : plan === 'monthly' ? '月付' : (plan || 'Pro');
            if (isExpiringSoon && daysRemaining != null) {
                return `Pro · ${planLabel} · 剩${daysRemaining}天`;
            }
            return `Pro · ${planLabel}`;
        }
        if (tier === 'trial') {
            if (daysRemaining != null && daysRemaining > 0)
                return `试用 · ${daysRemaining}天`;
            if (daysRemaining === 0)
                return '试用 · 今天到期';
            return '试用中';
        }
        // free — show the count for both normal and approaching so the
        // user can see exactly how close they are; the pill's amber
        // background (sub-pill-approaching) does the warning work.
        if (quotaState === 'exhausted')
            return 'Free · 已用完';
        if ((quotaState === 'normal' || quotaState === 'approaching') && usage) {
            return `Free · ${usage.used}/${usage.limit}`;
        }
        return 'Free';
    },
    formatTime(iso) {
        if (!iso)
            return '';
        const diff = Date.now() - new Date(iso).getTime();
        if (diff < 60000)
            return '刚刚';
        if (diff < 3600000)
            return `${Math.floor(diff / 60000)} 分钟前`;
        if (diff < 86400000)
            return `${Math.floor(diff / 3600000)} 小时前`;
        return new Date(iso).toLocaleDateString();
    },
});
function sessionTitle(session) {
    return session.metadata?.title || session.metadata?.claudeSessionId?.slice(0, 8) || session.id.slice(0, 8);
}
function sessionSubtitle(session) {
    return session.metadata?.cwd || session.metadata?.runtime || session.agent_type;
}
function agentColorClass(agentType) {
    if (agentType === 'codex')
        return 'codex';
    if (agentType === 'opencode')
        return 'opencode';
    if (agentType === 'claude-code' || agentType === 'claude-code-hook')
        return 'claude';
    return 'unknown';
}
