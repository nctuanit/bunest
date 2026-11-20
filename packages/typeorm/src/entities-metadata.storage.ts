import { getDataSourceName } from "./common/typeorm.utils";
import type { DataSourceRef } from "./interfaces/data-source-ref.type";
import type { EntityClassOrSchema } from "./interfaces/entity-class-or-schema.type";

export class EntitiesMetadataStorage {
  private static readonly storage = new Map<string, EntityClassOrSchema[]>();

  static addEntitiesByDataSource(
    dataSource: DataSourceRef,
    entities: EntityClassOrSchema[],
  ): void {
    const dataSourceName = getDataSourceName(dataSource);
    let collection = this.storage.get(dataSourceName);
    if (!collection) {
      collection = [];
      this.storage.set(dataSourceName, collection);
    }
    entities.forEach((entity) => {
      if (collection!.includes(entity)) {
        return;
      }
      collection!.push(entity);
    });
  }

  static getEntitiesByDataSource(
    dataSource: DataSourceRef,
  ): EntityClassOrSchema[] {
    return this.storage.get(getDataSourceName(dataSource)) || [];
  }

  static clear(): void {
    this.storage.clear();
  }
}
