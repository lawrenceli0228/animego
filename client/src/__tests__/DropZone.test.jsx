import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DropZone from '../components/player/DropZone';

vi.mock('../context/LanguageContext', () => ({
  useLang: () => ({
    t: (key) => ({
      'player.dropLabel': 'drop label',
      'player.dropTitle': 'Drop files here',
      'player.singleFile': 'Pick a single file',
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
