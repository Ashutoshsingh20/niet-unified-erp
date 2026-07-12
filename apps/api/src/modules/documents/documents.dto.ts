import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateDocumentTypeDto {
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/)
  typeKey!: string;

  @IsInt()
  @Min(1)
  version!: number;

  @IsString()
  @MinLength(3)
  @MaxLength(150)
  title!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @Matches(/^[a-z0-9][a-z0-9!#$&^_.+-]+\/[a-z0-9][a-z0-9!#$&^_.+-]+$/, { each: true })
  allowedMimeTypes!: string[];

  @IsInt()
  @Min(1)
  @Max(1_073_741_824)
  maxSizeBytes!: number;

  @IsIn(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'])
  classification!: 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

  @IsInt()
  @Min(1)
  @Max(36_500)
  retentionDays!: number;
}

export class InitiateDocumentUploadDto {
  @Matches(/^[a-z][a-z0-9_.-]{2,99}$/)
  documentTypeKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename!: string;

  @Matches(/^[a-z0-9][a-z0-9!#$&^_.+-]+\/[a-z0-9][a-z0-9!#$&^_.+-]+$/)
  mimeType!: string;

  @IsInt()
  @Min(1)
  @Max(1_073_741_824)
  sizeBytes!: number;

  @Matches(/^[a-f0-9]{64}$/)
  sha256!: string;

  @Matches(/^[a-z][a-z0-9_.-]{1,49}$/)
  scopeType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  scopeId!: string;
}

export class RecordDocumentScanDto {
  @IsIn(['CLEAN', 'REJECTED'])
  outcome!: 'CLEAN' | 'REJECTED';

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  scannerEngine!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  signatureVersion!: string;

  @Matches(/^[a-z0-9][a-z0-9!#$&^_.+-]+\/[a-z0-9][a-z0-9!#$&^_.+-]+$/)
  detectedMimeType!: string;

  @Matches(/^[a-f0-9]{64}$/)
  computedSha256!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}
