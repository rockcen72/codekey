export function renderQrCode(text: string): void {
  // TODO: render QR code in terminal using qrcode-terminal
  console.log('QR code rendering not yet implemented for:', text);
}

export function generatePairingCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}
