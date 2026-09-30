export type { Device, DeviceId, DeviceLabel, DevicePlatform, DeviceStatus, DeviceTransition } from "./device.js";
export {
  DEVICE_LABEL_MAX_LENGTH,
  DEVICE_PLATFORMS,
  DEVICE_STATUSES,
  isDeviceActive,
  parseDeviceId,
  parseDeviceLabel,
  parseDevicePlatform,
  registerDevice,
  restoreDevice,
  revokeDevice,
} from "./device.js";
