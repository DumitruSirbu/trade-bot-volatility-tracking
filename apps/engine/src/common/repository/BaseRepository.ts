import { DeepPartial, FindOptionsWhere, ObjectLiteral, Repository } from 'typeorm';

// Entities handled by the base repository expose a numeric primary key named
// `id`. Constraining the generic this way lets findById build a typed
// FindOptionsWhere<T> without an `as` workaround.
export type IdentifiableEntity = ObjectLiteral & { id: number };

// Base for every entity repository. Concrete repositories inject the TypeORM
// Repository<T> via @InjectRepository and pass it to super(), then expose
// intention-revealing query methods (findOpenBySymbol, ...). Services depend on
// these subclasses — never on Repository<T> or DataSource directly.
export abstract class BaseRepository<T extends IdentifiableEntity> {
    protected constructor(protected readonly repository: Repository<T>) {}

    // protected: subclasses build entities behind named methods rather than
    // exposing the generic TypeORM factory to services.
    protected create(entityLike: DeepPartial<T>): T {
        return this.repository.create(entityLike);
    }

    async save(entity: T): Promise<T> {
        return this.repository.save(entity);
    }

    async findById(id: number): Promise<T | null> {
        // FindOptionsWhere<T> is a mapped/conditional type TS can't infer from a
        // plain { id } literal; the generic constraint guarantees `id` exists, so
        // this single narrowing assertion is sound (not an `as unknown` escape).
        const where = { id } as FindOptionsWhere<T>;

        return this.repository.findOne({ where });
    }
}
