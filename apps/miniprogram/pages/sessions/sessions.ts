Page({
  data: {
    sessions: [] as Array<{
      id: string;
      agentType: string;
      projectName: string;
      status: string;
      lastActive: string;
    }>,
    ws: null as WebSocket | null,
  },

  onShow() {
    this.fetchSessions();
    this.connectWs();
  },

  onHide() {
    this.closeWs();
  },

  fetchSessions() {
    // TODO: GET /api/v1/sessions
  },

  connectWs() {
    // TODO: connect WSS for real-time updates
  },

  closeWs() {
    // TODO: close WebSocket
  },

  openSession(e: { currentTarget: { dataset: { id: string } } }) {
    wx.navigateTo({
      url: `/pages/session-detail/session-detail?id=${e.currentTarget.dataset.id}`,
    });
  },
});
