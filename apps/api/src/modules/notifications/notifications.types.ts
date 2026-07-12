import type { DataClassification } from '../../platform/evidence/transactional-evidence.service';

export interface NotificationTemplateRecord {
  readonly id: string;
  readonly template_key: string;
  readonly version: number;
  readonly title_template: string;
  readonly body_template: string;
  readonly required_variables: readonly string[];
  readonly allow_external_push: boolean;
}

export interface NotificationListItem {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly classification: DataClassification;
  readonly actionPath: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly expiresAt: string | null;
}

