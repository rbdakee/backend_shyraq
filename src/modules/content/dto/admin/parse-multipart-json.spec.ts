import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateContentDto } from './create-content.dto';
import { UpdateContentDto } from './update-content.dto';

// Multipart form fields are strings — the shape the admin web sends with media attached.
const multipartFields = {
  title_i18n: JSON.stringify({ ru: 'Новость', kz: 'Жаңалық' }),
  body_i18n: JSON.stringify({ ru: 'Текст' }),
  metadata: JSON.stringify({ month: '2026-10' }),
};

describe('content DTOs — JSON-stringified multipart fields', () => {
  it('parses object fields of an update and normalises kz → kk', () => {
    const dto = plainToInstance(UpdateContentDto, multipartFields);
    expect(validateSync(dto)).toEqual([]);
    expect(dto.title_i18n).toEqual({ ru: 'Новость', kk: 'Жаңалық' });
    expect(dto.metadata).toEqual({ month: '2026-10' });
  });

  it('parses object fields of a create', () => {
    const dto = plainToInstance(CreateContentDto, {
      content_type: 'news',
      target_type: 'all',
      ...multipartFields,
    });
    const fieldErrors = validateSync(dto).map((e) => e.property);
    expect(fieldErrors).not.toContain('title_i18n');
    expect(fieldErrors).not.toContain('body_i18n');
    expect(fieldErrors).not.toContain('metadata');
    expect(dto.body_i18n).toEqual({ ru: 'Текст' });
  });

  it('still rejects a string that is not JSON', () => {
    const dto = plainToInstance(UpdateContentDto, { title_i18n: 'not json' });
    expect(validateSync(dto).map((e) => e.property)).toContain('title_i18n');
  });
});
