/**
 * Tiny localized SMS templates for the post-bootstrap welcome message and
 * the SuperAdmin invite-admin flow. Pure function — no DI, no i18n service.
 * Falls back to Russian for unknown locales.
 */
export function buildWelcomeSms(
  locale: string,
  kindergartenName: string,
  phone: string,
): string {
  switch (locale) {
    case 'kk':
      return `"${kindergartenName}" кабинетi дайын. Admin App-қа ${phone} нөмiрiмен кiрiңiз.`;
    case 'ru':
    default:
      return `Кабинет "${kindergartenName}" готов. Войдите в Admin App по телефону ${phone}.`;
  }
}

export function buildAdminInviteSms(
  locale: string,
  kindergartenName: string,
): string {
  switch (locale) {
    case 'kk':
      return `Сiз "${kindergartenName}" балабақшасының әкiмшiсi болып тағайындалдыңыз. OTP арқылы кiрiңiз.`;
    case 'ru':
    default:
      return `Вы назначены администратором "${kindergartenName}". Войдите через OTP.`;
  }
}
