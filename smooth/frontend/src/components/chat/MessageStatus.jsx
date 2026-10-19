import Icon from '../ui/Icon.jsx'
import { utcDate } from '../../utils/formatLastSeen.js'
const formatter = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
export default function MessageStatus({ message, own }) {
  const state = message.read_at ? 'Read' : message.delivered_at ? 'Delivered' : 'Sent'
  return <span className="message-metadata">
    {message.edited_at && <span aria-label="Edited message">Edited</span>}
    <time dateTime={message.created_at}>{formatter.format(utcDate(message.created_at))}</time>
    {own && <span aria-label="Message status" data-read={Boolean(message.read_at)} ><Icon name={state === 'Sent' ? 'check' : 'checks'} size={15} /><span className="sr-only">{state}</span></span>}
  </span>
}
