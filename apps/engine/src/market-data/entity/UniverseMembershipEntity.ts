import { CoinTierEnum } from '@bot/shared';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// Point-in-time top-300 membership with tier, so backtests replay the universe as it
// WAS (no survivorship bias, ADR 0002 §4). enter → open row (left_at null); leave →
// set left_at; tier change → close prior row + open a fresh one. A gap-free timeline.
@Entity({ name: 'universe_membership', synchronize: false })
@Index('idx_universe_membership_symbol_entered_at', ['symbol', 'enteredAt'])
export class UniverseMembershipEntity {
    @PrimaryGeneratedColumn({ name: 'universe_membership_id' })
    id!: number;

    @Column({ name: 'symbol', type: 'varchar' })
    symbol!: string;

    @Column({ name: 'coin_tier', type: 'varchar' })
    coinTier!: CoinTierEnum;

    @Column({ name: 'entered_at', type: 'timestamptz' })
    enteredAt!: Date;

    @Column({ name: 'left_at', type: 'timestamptz', nullable: true })
    leftAt?: Date | null;
}
