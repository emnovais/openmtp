import React, { PureComponent } from 'react';
import { withStyles } from '@material-ui/core/styles';
import TableCell from '@material-ui/core/TableCell';
import TableRow from '@material-ui/core/TableRow';
import FileExplorerTableGridRender from '../../app/containers/HomePage/components/FileExplorerTableBodyGridRender';
import { quickHash } from '../../app/utils/funcs';
import { styles } from '../../app/containers/HomePage/styles/FileExplorerTableBodyGridWrapperRender';

// Keep these aligned with the existing Grid tile geometry. Two overscan rows
// cover the thumbnail observer's 120px nearby margin in both directions.
const TILE_WIDTH = 100;
const ROW_HEIGHT = 137;
const OVERSCAN_ROWS = 2;

class FileExplorerTableBodyGridWrapperRender extends PureComponent {
  constructor(props) {
    super(props);
    this.wrapper = React.createRef();
    this.state = { columns: 1, firstRow: 0, lastRow: 1 };
    this.frame = null;
  }

  componentDidMount() {
    const { deviceType } = this.props;

    this.scrollRoot = this.wrapper.current.closest(
      `#file-explorer-body-wrapper-${deviceType}`
    );
    this.scrollRoot.addEventListener('scroll', this.scheduleMeasure, {
      passive: true,
    });
    window.addEventListener('resize', this.scheduleMeasure);
    this.resizeObserver = new ResizeObserver(this.scheduleMeasure);
    this.resizeObserver.observe(this.wrapper.current);
    this.resizeObserver.observe(this.scrollRoot);
    this.measure();
  }

  componentDidUpdate(previous) {
    const {
      currentBrowsePath,
      deviceType,
      directoryLists,
      tableSort,
      directoryGeneratedTime,
    } = this.props;
    const directoryChanged =
      previous.currentBrowsePath?.[deviceType] !==
      currentBrowsePath?.[deviceType];

    if (directoryChanged) {
      this.scrollRoot.scrollTop = 0;
    } else if (previous.directoryLists !== directoryLists) {
      const { selected } = directoryLists[deviceType].queue;
      const oldSelected = previous.directoryLists[deviceType].queue.selected;
      const focused = selected[selected.length - 1];

      // Selection lives in the parent over the complete logical list. Reveal
      // keyboard selections outside the window without moving keyboard focus.
      if (
        focused &&
        focused !== oldSelected[oldSelected.length - 1] &&
        document.activeElement === this.scrollRoot
      ) {
        const index = tableSort.findIndex((item) => item.path === focused);

        if (index >= 0) this.reveal(index);
      }
    }

    if (
      directoryChanged ||
      previous.tableSort !== tableSort ||
      previous.directoryGeneratedTime !== directoryGeneratedTime
    ) {
      this.measure();
    }
  }

  componentWillUnmount() {
    this.scrollRoot.removeEventListener('scroll', this.scheduleMeasure);
    window.removeEventListener('resize', this.scheduleMeasure);
    this.resizeObserver.disconnect();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
  }

  scheduleMeasure = () => {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.measure();
    });
  };

  reveal = (index) => {
    const { columns } = this.state;
    const root = this.scrollRoot;
    const top =
      this.wrapper.current.getBoundingClientRect().top -
      root.getBoundingClientRect().top -
      root.clientTop +
      root.scrollTop +
      Math.floor(index / columns) * ROW_HEIGHT;

    if (top < root.scrollTop) root.scrollTop = top;
    else if (top + ROW_HEIGHT > root.scrollTop + root.clientHeight)
      root.scrollTop = top + ROW_HEIGHT - root.clientHeight;
    this.measure();
  };

  measure = () => {
    const { tableSort } = this.props;
    const previous = this.state;
    const root = this.scrollRoot;
    const box = this.wrapper.current.getBoundingClientRect();
    const columns = Math.max(1, Math.floor(box.width / TILE_WIDTH));
    const rows = Math.ceil(tableSort.length / columns);
    const top = root.getBoundingClientRect().top + root.clientTop - box.top;
    const firstRow = Math.max(
      0,
      Math.min(rows, Math.floor(top / ROW_HEIGHT) - OVERSCAN_ROWS)
    );
    const lastRow = Math.max(
      firstRow,
      Math.min(
        rows,
        Math.ceil((top + root.clientHeight) / ROW_HEIGHT) + OVERSCAN_ROWS
      )
    );

    if (
      columns !== previous.columns ||
      firstRow !== previous.firstRow ||
      lastRow !== previous.lastRow
    ) {
      this.setState({ columns, firstRow, lastRow });
    }
  };

  render() {
    const {
      classes: styles,
      tableSort,
      isSelected,
      ...parentProps
    } = this.props;
    const { columns, firstRow, lastRow } = this.state;
    const rows = Math.ceil(tableSort.length / columns);

    return (
      <TableRow>
        <TableCell colSpan={6} className={styles.gridTableCell}>
          <div
            ref={this.wrapper}
            className={styles.wrapper}
            style={{ position: 'relative', height: rows * ROW_HEIGHT }}
          >
            <div
              style={{
                position: 'absolute',
                top: firstRow * ROW_HEIGHT,
                width: '100%',
              }}
            >
              {tableSort
                .slice(firstRow * columns, lastRow * columns)
                .map((item) => (
                  <FileExplorerTableGridRender
                    {...parentProps}
                    key={quickHash(item.path)}
                    item={item}
                    isSelected={isSelected(item.path)}
                  />
                ))}
            </div>
          </div>
        </TableCell>
      </TableRow>
    );
  }
}

export default withStyles(styles)(FileExplorerTableBodyGridWrapperRender);
