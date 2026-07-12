import { ConflictException } from '@nestjs/common';
import { validateFilename } from '../src/modules/documents/documents.service';

describe('validateFilename', () => {
  it.each(['../identity.pdf', 'folder/identity.pdf', 'folder\\identity.pdf', ' identity.pdf',
    'identity.pdf ', 'identity\n.pdf'])('rejects unsafe filename %s', (filename) => {
    expect(() => validateFilename(filename)).toThrow(ConflictException);
  });

  it('accepts a plain Unicode filename', () => {
    expect(() => validateFilename('प्रमाण-पत्र.pdf')).not.toThrow();
  });
});

