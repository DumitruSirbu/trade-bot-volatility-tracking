export interface IPaginated<T> {
    items: T[];
    nextCursor: string | null;
    pageSize: number;
}
