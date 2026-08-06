/**
 * Bot i18n — alert & command strings in English / Khmer.
 * Per-user preference stored in users.language ('en' | 'km').
 */

export const botStrings = {
  en: {
    crash: (d) => [
      '🆘 <b>CRASH DETECTED!</b>',
      '',
      `Device: <code>${d.deviceId}</code>`,
      `Impact: ${d.impact ?? '?'} m/s²`,
      `Rotation: ${d.rotation ?? '?'} rad/s`,
      `Posture: Az=${d.az ?? '?'} m/s²`,
      d.locationLink ?? '',
      '',
      '⚠️ <b>Emergency services may need to be contacted.</b>',
    ].join('\n'),

    powerCut: (d) => [
      '🔌 <b>POWER CUT ALERT!</b>',
      '',
      `Device: <code>${d.deviceId}</code>`,
      `Battery: ${d.vbat ?? '?'}V`,
      '',
      'The main motorcycle battery has been disconnected.',
      'The device is now running on its internal backup battery.',
      '⚠️ This may indicate tampering or theft.',
    ].join('\n'),

    vanLift: (d) => [
      '🚨 <b>CRITICAL: Motion Detected Without GPS!</b>',
      '',
      `Device: <code>${d.deviceId}</code>`,
      'Your motorcycle is moving but GPS is blocked.',
      'This may indicate the bike has been loaded into a vehicle.',
      '⚠️ <b>Possible van-lift theft in progress!</b>',
    ].join('\n'),

    geofenceBreach: (d) => [
      '🚨 <b>GEOFENCE BREACH!</b>',
      '',
      `Device: <code>${d.deviceId}</code>`,
      `Zone: ${d.zone}`,
      `Distance: ${d.distance}m (limit: ${d.radius}m)`,
      `Speed: ${d.speed} km/h`,
      d.locationLink ?? '',
    ].join('\n'),

    heartbeatTimeout: (d) => [
      '⚠️ <b>Connection Lost</b>',
      '',
      `Device: <code>${d.deviceId}</code>`,
      `Last seen: ${d.lastSeen}`,
      'The device may be in an underground garage or the battery may be disconnected.',
      'Check your bike if this is unexpected.',
    ].join('\n'),

    langSet: '✅ Language set to English.',
    langPrompt: 'Choose your language / ជ្រើសរើសភាសា:',
  },

  km: {
    crash: (d) => [
      '🆘 <b>រកឃើញគ្រោះថ្នាក់ចរាចរណ៍!</b>',
      '',
      `ឧបករណ៍: <code>${d.deviceId}</code>`,
      `កម្លាំងបុក: ${d.impact ?? '?'} m/s²`,
      `ការបង្វិល: ${d.rotation ?? '?'} rad/s`,
      `ទ្រង់ទ្រាយ: Az=${d.az ?? '?'} m/s²`,
      d.locationLink ?? '',
      '',
      '⚠️ <b>ប្រហែលជាត្រូវការជំនួយសង្គ្រោះបន្ទាន់!</b>',
    ].join('\n'),

    powerCut: (d) => [
      '🔌 <b>ជូនដំណឹង: ថ្មត្រូវបានកាត់!</b>',
      '',
      `ឧបករណ៍: <code>${d.deviceId}</code>`,
      `ថ្ម: ${d.vbat ?? '?'}V`,
      '',
      'ថ្មម៉ូតូធំត្រូវបានផ្តាច់។',
      'ឧបករណ៍កំពុងដំណើរការដោយថ្មសំរអ។',
      '⚠️ នេះប្រហែលជាការពុះពារ ឬការលួច!',
    ].join('\n'),

    vanLift: (d) => [
      '🚨 <b>បន្ទាន់: ចលនាដោយគ្មានសញ្ញា GPS!</b>',
      '',
      `ឧបករណ៍: <code>${d.deviceId}</code>`,
      'ម៉ូតូរបស់អ្នកកំពុងផ្លាស់ទី ប៉ុន្តែ GPS ត្រូវបានរាំងខ្ទប់។',
      'ប្រហែលជាម៉ូតូត្រូវបានដាក់ចូលឡាន!',
      '⚠️ <b>ការលួចដាក់ឡានកំពុងកើតឡើង!</b>',
    ].join('\n'),

    geofenceBreach: (d) => [
      '🚨 <b>ម៉ូតូចេញក្រៅតំបន់!</b>',
      '',
      `ឧបករណ៍: <code>${d.deviceId}</code>`,
      `តំបន់: ${d.zone}`,
      `ចម្ងាយ: ${d.distance}m (កំណត់: ${d.radius}m)`,
      `ល្បឿន: ${d.speed} km/h`,
      d.locationLink ?? '',
    ].join('\n'),

    heartbeatTimeout: (d) => [
      '⚠️ <b>បាត់ការតភ្ជាប់</b>',
      '',
      `ឧបករណ៍: <code>${d.deviceId}</code>`,
      `ឃើញចុងក្រោយ: ${d.lastSeen}`,
      'ឧបករណ៍ប្រហែលជានៅក្នុងចំណតក្រោមដី ឬថ្មត្រូវបានផ្តាច់។',
      'សូមពិនិត្យម៉ូតូរបស់អ្នក។',
    ].join('\n'),

    langSet: '✅ ភាសាត្រូវបានកំណត់ជាភាសាខ្មែរ។',
    langPrompt: 'ជ្រើសរើសភាសា / Choose your language:',
  },
};

export function getBotStrings(lang) {
  return botStrings[lang === 'km' ? 'km' : 'en'];
}

/**
 * Fetch a user's language for alert localization, keyed by device.
 * Defaults to 'en'.
 */
export async function getLanguageForDevice(deviceId, env) {
  const row = await env.DB.prepare(
    `SELECT u.language FROM users u
     JOIN devices d ON d.owner_id = u.id
     WHERE d.device_id = ?`
  ).bind(deviceId).first();
  return row?.language === 'km' ? 'km' : 'en';
}
