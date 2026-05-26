import qrcode from 'qrcode-terminal';

export function renderQrCode(text: string): void {
  qrcode.generate(text, { small: true });
}
