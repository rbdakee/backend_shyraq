/**
 * Three-locale SMS template for the staff onboarding flow. Mirrors the
 * `welcome-sms.templates` over in KindergartenModule but targets the Staff
 * App login surface (not the Admin App).
 */
export function buildStaffWelcomeSms(
  locale: string,
  kindergartenName: string,
  phone: string,
): string {
  switch (locale) {
    case 'kk':
      return `"${kindergartenName}" қызметкер есептік жазбасы дайын. Staff App-қа ${phone} нөмiрiмен кiрiңiз.`;
    case 'en':
      return `Your "${kindergartenName}" staff account is ready. Sign in to the Staff App using ${phone}.`;
    case 'ru':
    default:
      return `Ваш аккаунт в "${kindergartenName}" готов. Войдите в Staff App по номеру ${phone}.`;
  }
}
