Page({
  data: {
    sessionId: '',
    session: null as Record<string, unknown> | null,
    events: [] as Array<Record<string, unknown>>,
    showApproval: false,
    currentEvent: null as Record<string, unknown> | null,
    riskLevel: '',
    replyText: '',
  },

  onLoad(options: { id: string }) {
    this.setData({ sessionId: options.id });
    this.fetchDetail();
  },

  fetchDetail() {
    // TODO: GET /api/v1/sessions/:id
    // TODO: GET /api/v1/sessions/:id/events
  },

  showApprovalCard(e: { currentTarget: { dataset: { event: string } } }) {
    const event = JSON.parse(e.currentTarget.dataset.event);
    this.setData({
      showApproval: true,
      currentEvent: event,
      riskLevel: event.riskLevel ?? 'unknown',
    });
  },

  closeApprovalCard() {
    this.setData({ showApproval: false, currentEvent: null, replyText: '' });
  },

  approve() {
    // TODO: POST response
    this.closeApprovalCard();
  },

  deny() {
    // TODO: POST response
    this.closeApprovalCard();
  },

  pause() {
    // TODO: POST /api/v1/sessions/:id/pause
  },

  onReplyInput(e: { detail: { value: string } }) {
    this.setData({ replyText: e.detail.value });
  },

  sendReply() {
    // TODO: POST response with message
    this.closeApprovalCard();
  },
});
