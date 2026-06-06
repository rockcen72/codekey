interface Props {
  name?: string;
}

export function DeviceBadge({ name }: Props) {
  return <span className="device-badge">{name || '未命名设备'}</span>;
}
