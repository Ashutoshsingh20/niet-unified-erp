import { renderTextTemplate } from '../src/modules/notifications/notifications.service';

describe('renderTextTemplate', () => {
  it('substitutes variables as plain text', () => {
    expect(renderTextTemplate('Result for {{courseName}} is ready', {
      courseName: '<script>alert(1)</script>',
    })).toBe('Result for <script>alert(1)</script> is ready');
  });

  it('does not evaluate variable content as a second template', () => {
    expect(renderTextTemplate('Hello {{name}}', { name: '{{other}}' }))
      .toBe('Hello {{other}}');
  });
});

