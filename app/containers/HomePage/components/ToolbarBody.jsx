import React, { PureComponent } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import MenuIcon from '@material-ui/icons/Menu';
import ViewListIcon from '@material-ui/icons/ViewList';
import ViewModuleIcon from '@material-ui/icons/ViewModule';
import CheckIcon from '@material-ui/icons/Check';
import AppBar from '@material-ui/core/AppBar';
import Toolbar from '@material-ui/core/Toolbar';
import Drawer from '@material-ui/core/Drawer';
import IconButton from '@material-ui/core/IconButton';
import Tooltip from '@material-ui/core/Tooltip';
import Menu from '@material-ui/core/Menu';
import MenuItem from '@material-ui/core/MenuItem';
import ListItemIcon from '@material-ui/core/ListItemIcon';
import classNames from 'classnames';
import {
  faSdCard,
  faBolt,
  faTerminal,
} from '@fortawesome/free-solid-svg-icons';
import SidebarAreaPaneLists from './SidebarAreaPaneLists';
import { LazyLoaderOverlay } from '../styles/ToolbarAreaPane';
import { DEVICES_LABEL } from '../../../constants';
import {
  Confirm as ConfirmDialog,
  Selection as SelectionDialog,
} from '../../../components/DialogBox';
import { DEVICE_TYPE, MTP_MODE, FILE_EXPLORER_VIEW_TYPE } from '../../../enums';
import { capitalize, isEmpty } from '../../../utils/funcs';
import { imgsrc } from '../../../utils/imgsrc';
import { isKalamModeSupported } from '../../../helpers/binaries';

export default class ToolbarAreaPane extends PureComponent {
  constructor(props) {
    super(props);
    this.state = {
      viewMenuAnchorEl: null,
    };
  }

  restoreExplorerFocus = false;

  _handleOpenViewMenu = (event) => {
    this.restoreExplorerFocus = false;
    this.setState({ viewMenuAnchorEl: event.currentTarget });
  };

  _handleCloseViewMenu = () => {
    this.setState({ viewMenuAnchorEl: null });
  };

  _handleViewModeChange = (value) => {
    const { onViewModeChange } = this.props;

    this.restoreExplorerFocus = true;
    onViewModeChange(value);
    this._handleCloseViewMenu();
  };

  _handleViewMenuExited = () => {
    if (this.restoreExplorerFocus) {
      const { onViewModeFocus } = this.props;

      this.restoreExplorerFocus = false;
      onViewModeFocus();
    }
  };

  activeToolbarList = ({ ...args }) => {
    const {
      toolbarList,
      directoryLists,
      currentBrowsePath,
      deviceType,
      mtpStoragesList,
      mtpDevice,
      mtpMode,
    } = args;

    const _directoryLists = directoryLists[deviceType];
    const _currentBrowsePath = currentBrowsePath[deviceType];
    const _activeToolbarList = toolbarList[deviceType];
    const isMtp = deviceType === DEVICE_TYPE.mtp;

    let enabled = true;

    if (isMtp && mtpMode === MTP_MODE.kalam) {
      enabled = !mtpDevice.isLoading;
    }

    Object.keys(_activeToolbarList).map((a) => {
      const item = _activeToolbarList[a];

      switch (a) {
        case 'up':
          _activeToolbarList[a] = {
            ...item,
            enabled: _currentBrowsePath !== '/' && enabled,
          };
          break;

        case 'refresh':
          _activeToolbarList[a] = {
            ...item,
            enabled,
          };
          break;

        case 'delete':
          _activeToolbarList[a] = {
            ...item,
            enabled: _directoryLists.queue.selected.length > 0 && enabled,
          };
          break;

        case 'storage':
          _activeToolbarList[a] = {
            ...item,
            enabled:
              Object.keys(mtpStoragesList).length > 0 &&
              isMtp &&
              mtpDevice.isAvailable &&
              enabled,
          };
          break;

        case 'settings':
          _activeToolbarList[a] = {
            ...item,
          };
          break;

        case 'mtpMode':
          _activeToolbarList[a] = {
            ...item,
          };
          break;
        default:
          break;
      }

      return _activeToolbarList;
    });

    return _activeToolbarList;
  };

  render() {
    const {
      directoryLists,
      mtpDevice,
      styles,
      sidebarFavouriteList,
      deviceType,
      showMenu,
      currentBrowsePath,
      mtpStoragesList,
      toggleDeleteConfirmDialog,
      toggleMtpStorageSelectionDialog,
      toggleMtpModeSelectionDialog,
      toolbarList,
      isLoadedDirectoryLists,
      toggleDrawer,
      appThemeMode,
      onDeleteConfirmDialog,
      onMtpStoragesListClick,
      onMtpModeSelectionDialogClick,
      onToggleDrawer,
      onListDirectory,
      onDoubleClickToolBar,
      onToolbarAction,
      showLocalPaneOnLeftSide,
      mtpMode,
      fileExplorerListingType,
    } = this.props;

    const { viewMenuAnchorEl } = this.state;
    const viewMenuOpen = Boolean(viewMenuAnchorEl);
    const viewButtonId = `file-explorer-view-button-${deviceType}`;
    const viewMenuId = `file-explorer-view-menu-${deviceType}`;
    const viewMode = fileExplorerListingType[deviceType];
    const isListView = viewMode === FILE_EXPLORER_VIEW_TYPE.list;
    const viewOptions = [
      { value: FILE_EXPLORER_VIEW_TYPE.list, label: 'List View' },
      { value: FILE_EXPLORER_VIEW_TYPE.grid, label: 'Grid View' },
    ];

    const _toolbarList = this.activeToolbarList({
      toolbarList,
      directoryLists,
      currentBrowsePath,
      deviceType,
      mtpStoragesList,
      mtpDevice,
      mtpMode,
    });

    const RenderLazyLoaderOverlay = LazyLoaderOverlay({ appThemeMode });
    let _mtpStoragesList = [];

    if (!isEmpty(mtpStoragesList)) {
      _mtpStoragesList = Object.keys(mtpStoragesList).map((a) => {
        // spread operator is used here to prevent modifying the original object
        const item = { ...mtpStoragesList[a] };

        item.icon = faSdCard;
        item.value = a;

        return item;
      });
    }

    const mtpModeList = [
      {
        value: MTP_MODE.kalam,
        name: `${capitalize(MTP_MODE.kalam)} Mode`,
        icon: faBolt,
        selected: mtpMode === MTP_MODE.kalam,
        hint: 'The all new and powerful MTP kernel — named after Dr. A. P. J. Abdul Kalam - Statesman, Scientist and Poet',
      },
      {
        value: MTP_MODE.legacy,
        name: `${capitalize(MTP_MODE.legacy)} Mode`,
        icon: faTerminal,
        selected: mtpMode === MTP_MODE.legacy,
        hint: `Previous generation MTP Kernel. Use this if Kalam mode doesn't detect your phone`,
      },
    ];

    // We have now officially retired the support for `Kalam` Kernel on macOS 10.13 (OS X El High Sierra) and lower. Only the "Legacy" MTP mode will continue working on these outdated machines.
    const showMtpModeSelection = isKalamModeSupported();

    return (
      <div className={styles.root}>
        <ConfirmDialog
          fullWidthDialog
          maxWidthDialog="xs"
          bodyText={`Are you sure you want to permanently delete the items from your ${DEVICES_LABEL[deviceType]}?`}
          trigger={toggleDeleteConfirmDialog}
          onClickHandler={onDeleteConfirmDialog}
        />
        <SelectionDialog
          titleText="Select Storage Option"
          list={_mtpStoragesList}
          id="selectionDialog"
          showAvatar
          open={
            deviceType === DEVICE_TYPE.mtp && toggleMtpStorageSelectionDialog
          }
          onClose={onMtpStoragesListClick}
        />

        {showMtpModeSelection && (
          <SelectionDialog
            titleText="Select MTP Mode"
            list={mtpModeList}
            id="selectionDialog"
            showAvatar
            open={
              deviceType === DEVICE_TYPE.mtp && toggleMtpModeSelectionDialog
            }
            onClose={onMtpModeSelectionDialogClick}
          />
        )}
        <Drawer
          open={toggleDrawer}
          onClose={onToggleDrawer(false)}
          anchor={!showLocalPaneOnLeftSide ? 'right' : 'left'}
        >
          <div
            tabIndex={0}
            role="button"
            onClick={onToggleDrawer(false)}
            onKeyDown={onToggleDrawer(false)}
          />
          <SidebarAreaPaneLists
            onClickHandler={onListDirectory}
            sidebarFavouriteList={sidebarFavouriteList}
            deviceType={deviceType}
            currentBrowsePath={currentBrowsePath[deviceType]}
          />
        </Drawer>

        {!isLoadedDirectoryLists && <RenderLazyLoaderOverlay />}

        <AppBar position="static" elevation={0} className={styles.appBar}>
          <Toolbar
            className={styles.toolbar}
            disableGutters
            onDoubleClick={(event) => {
              onDoubleClickToolBar(event);
            }}
          >
            {showMenu && (
              <IconButton color="inherit" onClick={onToggleDrawer(true)}>
                <MenuIcon />
              </IconButton>
            )}

            <div
              className={`${styles.toolbarInnerWrapper} ${styles.noAppDrag}`}
              style={{ flex: '0 1 auto', minWidth: 0, overflowX: 'auto' }}
              onFocusCapture={(event) =>
                event.target.scrollIntoView({
                  block: 'nearest',
                  inline: 'nearest',
                })
              }
            >
              {Object.keys(_toolbarList).map((a) => {
                const item = _toolbarList[a];

                return (
                  <Tooltip key={a} title={item.label}>
                    <div
                      className={`${styles.navBtns} ${styles.noAppDrag}`}
                      style={{ flexShrink: 0 }}
                    >
                      <IconButton
                        aria-label={item.label}
                        disabled={!item.enabled}
                        onClick={() => onToolbarAction(a)}
                        className={classNames({
                          [styles.disabledNavBtns]: !item.enabled,
                          [styles.invertedNavBtns]: item.invert,
                          [styles.imageBtn]: item.image,
                        })}
                      >
                        {item.image && (
                          <img
                            alt={item.label}
                            src={imgsrc(item.image, false)}
                            className={styles.navBtnImages}
                          />
                        )}

                        {item.icon && (
                          <FontAwesomeIcon
                            icon={item.icon}
                            className={styles.navBtnIcons}
                            title={item.label}
                          />
                        )}
                      </IconButton>
                    </div>
                  </Tooltip>
                );
              })}
            </div>
            <div
              className={`${styles.navBtns} ${styles.noAppDrag}`}
              style={{ flexShrink: 0 }}
            >
              <Tooltip
                title={`View: ${isListView ? 'List View' : 'Grid View'}`}
              >
                <IconButton
                  id={viewButtonId}
                  size="small"
                  aria-label={`${DEVICES_LABEL[deviceType]} view`}
                  aria-haspopup="menu"
                  aria-controls={viewMenuOpen ? viewMenuId : undefined}
                  aria-expanded={viewMenuOpen}
                  onClick={this._handleOpenViewMenu}
                >
                  {isListView ? (
                    <ViewListIcon className={styles.navBtnIcons} />
                  ) : (
                    <ViewModuleIcon className={styles.navBtnIcons} />
                  )}
                </IconButton>
              </Tooltip>
            </div>
            <Menu
              id={viewMenuId}
              anchorEl={viewMenuAnchorEl}
              open={viewMenuOpen}
              onClose={this._handleCloseViewMenu}
              disableRestoreFocus={this.restoreExplorerFocus}
              MenuListProps={{ 'aria-labelledby': viewButtonId }}
              TransitionProps={{ onExited: this._handleViewMenuExited }}
            >
              {viewOptions.map(({ value, label }) => (
                <MenuItem
                  key={value}
                  role="menuitemradio"
                  aria-checked={viewMode === value}
                  selected={viewMode === value}
                  onClick={() => this._handleViewModeChange(value)}
                >
                  <ListItemIcon style={{ minWidth: 32 }}>
                    <CheckIcon
                      fontSize="small"
                      style={{
                        visibility: viewMode === value ? 'visible' : 'hidden',
                      }}
                    />
                  </ListItemIcon>
                  {label}
                </MenuItem>
              ))}
            </Menu>
          </Toolbar>
        </AppBar>
      </div>
    );
  }
}
