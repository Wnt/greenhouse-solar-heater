function normalizeUserAgent(ua) {
  return typeof ua === 'string' ? ua.trim() : '';
}

function detectBrowser(ua) {
  if (!ua) return null;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua) || /CriOS\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua) && !/Chrome|CriOS|Chromium|Edg\//.test(ua)) return 'Safari';
  return null;
}

function detectOs(ua) {
  if (!ua) return null;
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return null;
}

function detectDeviceType(ua) {
  if (!ua) return null;
  if (/iPad|Tablet/.test(ua)) return 'tablet';
  if (/Mobile|iPhone|Android/.test(ua)) return 'phone';
  return 'desktop';
}

function detectDeviceName(ua) {
  if (!ua) return null;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Android/.test(ua)) return /Tablet/.test(ua) ? 'Android tablet' : 'Android phone';
  if (/Linux/.test(ua)) return 'Linux device';
  return null;
}

function buildDeviceDetails(userAgent) {
  const ua = normalizeUserAgent(userAgent);
  const browser = detectBrowser(ua);
  const os = detectOs(ua);
  const deviceType = detectDeviceType(ua);
  const deviceName = detectDeviceName(ua);
  const parts = [];
  if (deviceName) parts.push(deviceName);
  if (browser) parts.push(browser);
  if (os && os !== deviceName) parts.push(os);
  return {
    userAgent: ua || null,
    browser,
    os,
    deviceType,
    deviceName,
    summary: parts.length ? parts.join(' · ') : 'Unknown device',
  };
}

module.exports = {
  buildDeviceDetails,
};
