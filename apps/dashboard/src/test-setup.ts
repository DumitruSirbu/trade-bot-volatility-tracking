// Global test setup for the dashboard Vitest suite.
// Loads jest-dom matchers so `expect(el).toBeInTheDocument()` etc. work.
import '@testing-library/jest-dom';

// jsdom does not implement ResizeObserver. Radix UI components (Dialog, Sheet,
// etc.) reference it at component init; without this stub those components
// throw in tests.
global.ResizeObserver = class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
};
