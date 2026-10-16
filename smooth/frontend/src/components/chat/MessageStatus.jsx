import { utcDate } from '../../utils/formatLastSeen.js'
export default function MessageStatus({ message, own }) {
  const state = message.read_at ? 'Read' : message.delivered_at ? 'Delivered' : 'Sent'
  return <span className="message-metadata">
    {message.edited_at && <span aria-label="Edited message">Edited</span>}
    <time dateTime={message.created_at}>{utcDate(message.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</time>
    {own && <span aria-label="Message status" data-read={Boolean(message.read_at)}><span aria-hidden="true">{state === 'Sent' ? '✓' : '✓✓'}</span><span className="sr-only">{state}</span></span>}
  </span>
}
