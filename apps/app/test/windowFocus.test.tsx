import { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { trackPointer } from '../src/canvas/gestures';
import { useDismiss, type DismissOptions } from '../src/ui/useDismiss';
import { InlineRename } from '../src/ui/InlineRename';

const pointer = (type: string) => new PointerEvent(type, { clientX: 1, clientY: 1 });

afterEach(() => vi.restoreAllMocks());

describe('trackPointer', () => {
  const start = () => {
    const calls = { move: 0, up: 0, cancel: 0 };
    trackPointer(
      () => calls.move++,
      () => calls.up++,
      () => calls.cancel++,
    );
    return calls;
  };

  it('ends on pointerup and stops listening', () => {
    const calls = start();
    window.dispatchEvent(pointer('pointermove'));
    window.dispatchEvent(pointer('pointerup'));
    window.dispatchEvent(pointer('pointermove'));
    window.dispatchEvent(new Event('blur'));
    expect(calls).toEqual({ move: 1, up: 1, cancel: 0 });
  });

  it.each(['blur', 'pointercancel'])('aborts on %s without committing', (type) => {
    const calls = start();
    window.dispatchEvent(type === 'blur' ? new Event('blur') : pointer('pointercancel'));
    window.dispatchEvent(pointer('pointermove'));
    window.dispatchEvent(pointer('pointerup'));
    expect(calls).toEqual({ move: 0, up: 0, cancel: 1 });
  });

  it('aborts on Escape and keeps the key from other listeners', () => {
    const calls = start();
    const later = vi.fn();
    document.addEventListener('keydown', later);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(esc);
    document.removeEventListener('keydown', later);
    expect(calls.cancel).toBe(1);
    expect(esc.defaultPrevented).toBe(true);
    expect(later).not.toHaveBeenCalled();
    // Once over, Escape is no longer taken.
    const again = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
  });
});

function Popup({ onClose, opts }: { onClose(): void; opts?: Omit<DismissOptions, 'ref'> }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(onClose, { ref, ...opts });
  return (
    <div>
      <div ref={ref} data-testid="inside" />
      <div data-testid="outside" />
    </div>
  );
}

describe('useDismiss', () => {
  it('closes on window blur, resize and a wheel outside', () => {
    for (const fire of [() => window.dispatchEvent(new Event('blur')), () => window.dispatchEvent(new Event('resize')), () => fireEvent.wheel(screen.getByTestId('outside'))]) {
      const onClose = vi.fn();
      const { unmount } = render(<Popup onClose={onClose} />);
      fire();
      expect(onClose).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('keeps it open for a wheel inside, and for blur when blur is off', () => {
    const onClose = vi.fn();
    render(<Popup onClose={onClose} opts={{ blur: false }} />);
    fireEvent.wheel(screen.getByTestId('inside'));
    window.dispatchEvent(new Event('blur'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('InlineRename across window focus', () => {
  const startEditing = (onCommit: (name: string) => void) => {
    render(<InlineRename value="Old" onCommit={onCommit} />);
    fireEvent.doubleClick(screen.getByText('Old'));
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New' } });
    return input;
  };

  it('does not commit when the window loses focus, and goes on editing when it returns', () => {
    const onCommit = vi.fn();
    const input = startEditing(onCommit);
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    act(() => input.blur());
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toBe(input);
    hasFocus.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(document.activeElement).toBe(input);
    act(() => input.blur());
    expect(onCommit).toHaveBeenCalledWith('New');
  });

  it('commits on a blur inside the app', () => {
    const onCommit = vi.fn();
    const input = startEditing(onCommit);
    act(() => input.blur());
    expect(onCommit).toHaveBeenCalledWith('New');
  });
});
