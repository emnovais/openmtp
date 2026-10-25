/* eslint global-require: off */
import React, { PureComponent } from 'react';
import {
  isLocalThumbnailItem,
  LocalThumbnailProvider,
} from '../../../data/file-explorer/thumbnails/LocalThumbnailProvider';
import { ThumbnailService } from '../../../data/file-explorer/thumbnails/ThumbnailService';

const service = new ThumbnailService({
  provider: new LocalThumbnailProvider(),
});

export default class FileExplorerThumbnail extends PureComponent {
  constructor(props) {
    super(props);
    this.state = { src: null };
    this.image = React.createRef();
    this.version = 0;
    this.visible = false;
    this.mounted = false;
  }

  componentDidMount() {
    this.mounted = true;
    this.observe();
  }

  componentDidUpdate(prev) {
    const { item, revision, deviceType, mtpContext } = this.props;

    if (
      prev.item !== item ||
      prev.item.path !== item.path ||
      prev.item.size !== item.size ||
      prev.item.dateAdded !== item.dateAdded ||
      prev.revision !== revision ||
      prev.deviceType !== deviceType ||
      prev.mtpContext?.key !== mtpContext?.key
    ) {
      this.stop();
      this.setState({ src: null });
      this.observe();
    }
  }

  componentWillUnmount() {
    this.mounted = false;
    this.stop();
  }

  stop = () => {
    this.version += 1;
    this.visible = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.capacityUnsubscribe?.();
    this.capacityUnsubscribe = null;
    this.request?.cancel();
    this.request = null;
    this.observer?.disconnect();
    this.observer = null;
  };

  observe = () => {
    const { item, deviceType, revision, mtpContext } = this.props;
    const root = this.image.current?.closest(
      `#file-explorer-body-wrapper-${deviceType}`
    );
    const mtp =
      deviceType === 'mtp' && mtpContext
        ? require('../../../data/file-explorer/thumbnails/MtpThumbnailProvider')
        : null;
    const contextIsCurrent = () =>
      !mtp || mtp.isMtpThumbnailContextCurrent(mtpContext);

    // Without a viewport observer or panel root, keep the existing icon.
    if (
      !root ||
      typeof IntersectionObserver === 'undefined' ||
      !(isLocalThumbnailItem(item, deviceType) || (mtp && contextIsCurrent()))
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!this.mounted || this.observer !== observer) return;
        const entry = entries.find(
          (value) => value.target === this.image.current
        );

        if (!entry || entry.isIntersecting === this.visible) return;
        this.visible = entry.isIntersecting;
        this.version += 1;
        this.request?.cancel();
        this.request = null;
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.capacityUnsubscribe?.();
        this.capacityUnsubscribe = null;
        if (!this.visible) {
          this.setState({ src: null });

          return;
        }

        const { version } = this;
        const providerService = mtp ? mtp.getMtpThumbnailService() : service;

        if (mtp)
          this.unsubscribe = mtp.subscribeMtpThumbnailContext(
            mtpContext,
            () => {
              this.stop();
              this.setState({ src: null });
            }
          );

        const isCurrent = () =>
          this.mounted &&
          this.visible &&
          this.version === version &&
          contextIsCurrent();
        const attempt = () => {
          if (!isCurrent()) return;
          this.request?.cancel();
          this.request = providerService.request(item, {
            revision: mtpContext?.key || revision,
            context: mtpContext,
            isCurrent,
            onResult: (src) => this.setState({ src }),
          });
          if (mtp && this.request.deferred) {
            if (!this.capacityUnsubscribe)
              this.capacityUnsubscribe =
                providerService.subscribeCapacity(attempt);
          } else {
            this.capacityUnsubscribe?.();
            this.capacityUnsubscribe = null;
          }
        };

        attempt();
      },
      { root, rootMargin: '120px 0px', threshold: 0 }
    );

    this.observer = observer;
    observer.observe(this.image.current);
  };

  render() {
    const { item, fallbackSrc, className, thumbnailClassName, onContextMenu } =
      this.props;
    const { src } = this.state;

    return (
      <img
        ref={this.image}
        src={src || fallbackSrc}
        alt={item.name}
        className={src ? `${className} ${thumbnailClassName}` : className}
        onContextMenu={onContextMenu}
        onError={() => {
          if (src) this.request?.fail();
        }}
      />
    );
  }
}
