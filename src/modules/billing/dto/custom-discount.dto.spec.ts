import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateCustomDiscountDto } from './custom-discount.dto';

/**
 * B22b T7 M9 — UpdateCustomDiscountDto cross-field validation.
 *
 * Mirrors the Create-DTO invariant "when notify_on_activation is on, both
 * `notification_title` and `notification_body` must be provided" but in
 * the PATCH context: the rule fires only when the patch *explicitly* sets
 * `notify_on_activation=true`. PATCHing `false`, omitting the flag, or
 * touching unrelated fields leaves the title/body optional.
 */
describe('UpdateCustomDiscountDto — M9 cross-field validation', () => {
  function validate(payload: Record<string, unknown>): string[] {
    const dto = plainToInstance(UpdateCustomDiscountDto, payload);
    const errors = validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: false,
    });
    return errors.map((e) => e.property);
  }

  it('accepts notify_on_activation=true when both title and body present', () => {
    const props = validate({
      notify_on_activation: true,
      notification_title: { ru: 'Заголовок', kk: 'Тақырып' },
      notification_body: { ru: 'Тело', kk: 'Тело kk' },
    });
    expect(props).toEqual([]);
  });

  it('rejects notify_on_activation=true without notification_title', () => {
    const props = validate({
      notify_on_activation: true,
      notification_body: { ru: 'Тело', kk: 'Тело kk' },
    });
    expect(props).toContain('notification_title');
  });

  it('rejects notify_on_activation=true without notification_body', () => {
    const props = validate({
      notify_on_activation: true,
      notification_title: { ru: 'Заголовок', kk: 'Тақырып' },
    });
    expect(props).toContain('notification_body');
  });

  it('rejects notify_on_activation=true with title=null (explicit nullification)', () => {
    const props = validate({
      notify_on_activation: true,
      notification_title: null,
      notification_body: { ru: 'Тело', kk: 'Тело kk' },
    });
    expect(props).toContain('notification_title');
  });

  it('accepts notify_on_activation=false without title/body', () => {
    const props = validate({
      notify_on_activation: false,
    });
    expect(props).toEqual([]);
  });

  it('accepts patch without notify_on_activation field (no cross-field check)', () => {
    // Cosmetic update — flipping cap, no opinion on notify.
    const props = validate({
      total_max_uses: 50,
    });
    expect(props).toEqual([]);
  });

  it('accepts patch that updates only the name', () => {
    const props = validate({
      name: { ru: 'Новое имя', kk: 'Жаңа атау' },
    });
    expect(props).toEqual([]);
  });
});
