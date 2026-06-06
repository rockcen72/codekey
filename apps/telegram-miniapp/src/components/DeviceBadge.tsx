interface Props {
  name?: string;
  deviceId?: string;
}

export function DeviceBadge({ name, deviceId }: Props) {
  const shortId = deviceId ? deviceId.slice(-6) : '';
  return <span className="device-badge">{name || '未命名设备'}{shortId ? ` (${shortId})` : ''}</span>;
}
