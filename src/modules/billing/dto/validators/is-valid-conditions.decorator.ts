import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { validateConditionsSchema } from '../../domain/discount-conditions/conditions-evaluator';

/**
 * Custom class-validator decorator that validates a `conditions` JSONB field
 * by delegating to the domain-layer `validateConditionsSchema` function.
 *
 * On success, the field value is left as-is (the service layer re-validates
 * and normalises via domain aggregate).
 * On failure, surfaces a 400 with `custom_discount_conditions_invalid`.
 */
export function IsValidConditions(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidConditions',
      target: (object as { constructor: new (...args: unknown[]) => unknown })
        .constructor,
      propertyName,
      options: {
        message: 'custom_discount_conditions_invalid',
        ...validationOptions,
      },
      validator: {
        validate(value: unknown, _args: ValidationArguments): boolean {
          try {
            validateConditionsSchema(value);
            return true;
          } catch {
            return false;
          }
        },
        defaultMessage(_args: ValidationArguments): string {
          return 'custom_discount_conditions_invalid';
        },
      },
    });
  };
}
