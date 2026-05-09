import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DropZone from '../components/player/DropZone';

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'player.dropLabel': 'drop label',
      'player.dropTitle': 'Drop files here',
      'player.dropRelease': 'Release to start parsing',
      'player.singleFile': 'Pick a single file',
      'player.parsing': 'Parsing…',
      'player.parseCancel': 'Cancel',
    }[key] || key),
  }),
}));

function makeFile(name) {
  return new File(['x'], name, { type: 'video/mp4' });
}

describe('DropZone', () => {
  it('renders the drop-target UI and single-file fallback button', () => {
    render(<DropZone onFiles={vi.fn()} />);
    expect(screen.getByText('Drop files here')).toBeInTheDocument();
    expect(screen.getByText('Pick a single file')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'drop label' })).toBeInTheDocument();
  });

  it('calls onFiles when files are dropped', async () => {
    const onFiles = vi.fn();
    render(<DropZone onFiles={onFiles} />);
    const zone = screen.getByRole('button', { name: 'drop label' });

    const files = [makeFile('a.mkv')];
    // No `items` API in this drop event — flattenDropFiles falls back to
    // dataTransfer.files. The handler is async (folder recursion path), so
    // wait for the microtask before asserting.
    fireEvent.drop(zone, { dataTransfer: { files } });

    await waitFor(() => expect(onFiles).toHaveBeenCalledTimes(1));
    expect(onFiles.mock.calls[0][0]).toEqual(files);
  });

  it('does not call onFiles when a drop event has no files', () => {
    const onFiles = vi.fn();
    render(<DropZone onFiles={onFiles} />);
    const zone = screen.getByRole('button', { name: 'drop label' });

    fireEvent.drop(zone, { dataTransfer: { files: [] } });
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('prevents default browser handling on dragover', () => {
    render(<DropZone onFiles={vi.fn()} />);
    const zone = screen.getByRole('button', { name: 'drop label' });

    // fireEvent returns false when preventDefault was called during the handler
    const notPrevented = fireEvent.dragOver(zone);
    expect(notPrevented).toBe(false);
  });

  it('opens the folder picker when the drop zone is clicked', () => {
    const onFiles = vi.fn();
    const { container } = render(<DropZone onFiles={onFiles} />);
    const folderInput = container.querySelector('input[type="file"][webkitdirectory]');
    const clickSpy = vi.spyOn(folderInput, 'click');

    const zone = screen.getByRole('button', { name: 'drop label' });
    fireEvent.click(zone);

    expect(clickSpy).toHaveBeenCalled();
  });

  it('opens the folder picker on Enter key when drop zone is focused', () => {
    const { container } = render(<DropZone onFiles={vi.fn()} />);
    const folderInput = container.querySelector('input[type="file"][webkitdirectory]');
    const clickSpy = vi.spyOn(folderInput, 'click');

    const zone = screen.getByRole('button', { name: 'drop label' });
    fireEvent.keyDown(zone, { key: 'Enter' });

    expect(clickSpy).toHaveBeenCalled();
  });

  it('opens the single-file picker when the fallback link is clicked', () => {
    const { container } = render(<DropZone onFiles={vi.fn()} />);
    const fileInput = container.querySelector('input[type="file"][accept="video/*"]');
    const clickSpy = vi.spyOn(fileInput, 'click');

    fireEvent.click(screen.getByText('Pick a single file'));

    expect(clickSpy).toHaveBeenCalled();
  });

  it('forwards file input changes to onFiles', () => {
    const onFiles = vi.fn();
    const { container } = render(<DropZone onFiles={onFiles} />);
    const folderInput = container.querySelector('input[type="file"][webkitdirectory]');

    const files = [makeFile('show.mkv')];
    // Simulate a change event carrying FileList-like data
    fireEvent.change(folderInput, { target: { files } });

    expect(onFiles).toHaveBeenCalledTimes(1);
  });
});

describe('DropZone — three states (§5.2)', () => {
  it('idle: data-state="idle" and shows dropTitle copy', () => {
    render(<DropZone onFiles={vi.fn()} />);
    const zone = screen.getByTestId('dropzone');
    expect(zone.getAttribute('data-state')).toBe('idle');
    expect(screen.getByText('Drop files here')).toBeInTheDocument();
  });

  it('dragging: data-state="dragging" after dragOver, copy swaps to release prompt', () => {
    render(<DropZone onFiles={vi.fn()} />);
    const zone = screen.getByTestId('dropzone');
    fireEvent.dragOver(zone);
    expect(zone.getAttribute('data-state')).toBe('dragging');
    expect(screen.getByText('Release to start parsing')).toBeInTheDocument();
  });

  it('dragging: dragLeave returns to idle', () => {
    render(<DropZone onFiles={vi.fn()} />);
    const zone = screen.getByTestId('dropzone');
    fireEvent.dragOver(zone);
    fireEvent.dragLeave(zone);
    expect(zone.getAttribute('data-state')).toBe('idle');
  });

  it('parsing: data-state="parsing" + counter + title rendered', () => {
    render(<DropZone onFiles={vi.fn()} parsing parsedCount={26} totalCount={47} />);
    const zone = screen.getByTestId('dropzone');
    expect(zone.getAttribute('data-state')).toBe('parsing');
    expect(zone.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('dropzone-parse-counter').textContent).toMatch(/0026 \/ 0047/);
    expect(screen.getByTestId('dropzone-parse-title').textContent).toMatch(/Parsing/);
  });

  it('parsing: progress fill width reflects parsedCount / totalCount', () => {
    render(<DropZone onFiles={vi.fn()} parsing parsedCount={10} totalCount={40} />);
    const fill = screen.getByTestId('dropzone-parse-fill');
    expect(fill.style.width).toBe('25%');
  });

  it('parsing: zero total renders 0% (no NaN)', () => {
    render(<DropZone onFiles={vi.fn()} parsing parsedCount={0} totalCount={0} />);
    const fill = screen.getByTestId('dropzone-parse-fill');
    expect(fill.style.width).toBe('0%');
  });

  it('parsing: shows currentFileName when provided', () => {
    render(
      <DropZone
        onFiles={vi.fn()}
        parsing
        parsedCount={5}
        totalCount={47}
        currentFileName="进击的巨人 - 23.mkv"
      />,
    );
    expect(screen.getByTestId('dropzone-parse-current').textContent).toMatch(/进击的巨人 - 23\.mkv/);
  });

  it('parsing: hides currentFileName block when not provided', () => {
    render(<DropZone onFiles={vi.fn()} parsing parsedCount={5} totalCount={47} />);
    expect(screen.queryByTestId('dropzone-parse-current')).toBeNull();
  });

  it('parsing: cancel button fires onCancelParsing without bubbling to zone click', () => {
    const onCancel = vi.fn();
    const onFiles = vi.fn();
    render(
      <DropZone
        onFiles={onFiles}
        parsing
        parsedCount={5}
        totalCount={47}
        onCancelParsing={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId('dropzone-parse-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('parsing: cancel button is hidden when onCancelParsing is not provided', () => {
    render(<DropZone onFiles={vi.fn()} parsing parsedCount={5} totalCount={47} />);
    expect(screen.queryByTestId('dropzone-parse-cancel')).toBeNull();
  });

  it('parsing: drop is no-op (does not call onFiles)', async () => {
    const onFiles = vi.fn();
    render(<DropZone onFiles={onFiles} parsing parsedCount={5} totalCount={47} />);
    const zone = screen.getByTestId('dropzone');
    fireEvent.drop(zone, { dataTransfer: { files: [makeFile('a.mkv')] } });
    // Wait a tick to confirm nothing fires
    await new Promise((r) => setTimeout(r, 10));
    expect(onFiles).not.toHaveBeenCalled();
  });

  it('parsing: zone click does not open folder picker', () => {
    const { container } = render(
      <DropZone onFiles={vi.fn()} parsing parsedCount={5} totalCount={47} />,
    );
    const folderInput = container.querySelector('input[type="file"][webkitdirectory]');
    const clickSpy = vi.spyOn(folderInput, 'click');
    fireEvent.click(screen.getByTestId('dropzone'));
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('parsing: single-file fallback button is disabled', () => {
    render(<DropZone onFiles={vi.fn()} parsing parsedCount={5} totalCount={47} />);
    expect(screen.getByText('Pick a single file')).toBeDisabled();
  });

  it('parsing: percentage clamps at 100% even if parsed > total', () => {
    render(<DropZone onFiles={vi.fn()} parsing parsedCount={50} totalCount={47} />);
    const fill = screen.getByTestId('dropzone-parse-fill');
    expect(fill.style.width).toBe('100%');
  });
});
